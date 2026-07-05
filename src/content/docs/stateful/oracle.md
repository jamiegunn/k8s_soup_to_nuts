---
title: Oracle on Kubernetes
description: The honest take on Oracle Database and Kubernetes — licensing landmines, the OraOperator, and the connection patterns for keeping Oracle off-cluster.
sidebar:
  order: 6
---

Oracle on Kubernetes is rare, and the reasons are mostly not technical. Before we talk pods: the most common correct architecture is **Oracle stays where it is** — on the appliance, the Exadata, the DBA-managed VMs, or a cloud service — **and your Kubernetes workloads connect to it**. Skip to the last section if that's your situation; it's the part you'll actually use.

:::tip[War story]
If you are running Oracle Database Free in a local VM on Apple Silicon and it crash-loops with `ORA-01012`, check out our Field Note: [The Oracle Database That Hated Time Travel](/blog/the-oracle-database-that-hated-time-travel/) — a deep dive into VM time drift aborts and how to prevent them.
:::

## The licensing landmine (read this before scheduling anything)

Oracle's processor licensing counts cores the software **can run on**, and Oracle's position on soft partitioning has historically been hostile: on a virtualized or orchestrated platform, auditors may argue you owe licenses for every node the database *could* be scheduled to — not the one node it's on. On a 60-node shared cluster, "we ran one Oracle pod for a sprint" can become an audit finding priced against the whole cluster's cores.

:::danger[Talk to licensing before you talk to the scheduler]
Do not deploy licensed Oracle editions (SE2/EE) onto a shared Kubernetes cluster without written sign-off from whoever owns your Oracle agreement. If you do get approval, the standard containment pattern is a **dedicated, pinned node pool**: your platform team labels and taints a fixed set of nodes, and your pods carry matching `nodeAffinity` and `tolerations` so Oracle can only ever land there. That's a platform-team conversation — you can't create node pools or taints yourself.
:::

```yaml
# On your pod spec — only meaningful once platform has created the pinned pool
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
            - key: workload.example.com/oracle-licensed
              operator: In
              values: ["true"]
tolerations:
  - key: "oracle-licensed"
    operator: "Exists"
    effect: "NoSchedule"
```

Whether a pinned pool satisfies your contract is a question for licensing, not for this guide — get it in writing.

## Where Oracle-on-k8s does make sense

### Dev/test with Oracle Database Free

**Oracle Database Free** (the successor to XE; `container-registry.oracle.com/database/free`) is genuinely useful: free license, real Oracle 23ai compatibility for integration tests, runs fine as a single pod. Limits (as of 23ai Free): 2 CPU threads, 2GB RAM used by the DB, 12GB user data — irrelevant for CI, disqualifying for prod.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oracle-free
spec:
  replicas: 1
  strategy: { type: Recreate }     # RWO volume — no overlapping pods
  selector:
    matchLabels: { app: oracle-free }
  template:
    metadata:
      labels: { app: oracle-free }
    spec:
      containers:
        - name: db
          image: container-registry.oracle.com/database/free:23.6.0.0
          ports: [{ containerPort: 1521 }]
          env:
            - name: ORACLE_PWD
              valueFrom: { secretKeyRef: { name: oracle-free, key: password } }
          readinessProbe:
            exec: { command: ["/bin/sh", "-c", "$ORACLE_BASE/checkDBStatus.sh"] }
            initialDelaySeconds: 120   # first boot creates the DB: several minutes
            periodSeconds: 30
            failureThreshold: 20
          resources:
            requests: { cpu: "1", memory: 4Gi }
            limits:   { memory: 6Gi }
          volumeMounts:
            - { name: oradata, mountPath: /opt/oracle/oradata }
            - { name: dshm, mountPath: /dev/shm }
      volumes:
        - name: oradata
          persistentVolumeClaim: { claimName: oracle-free-data }
        - name: dshm
          emptyDir: { medium: Memory }
```

:::caution[The /dev/shm trap]
By default, Kubernetes mounts `/dev/shm` (shared memory) inside containers with a limit of only **64Mi**. Oracle Database relies on shared memory to allocate its SGA (System Global Area). If `/dev/shm` is limited to 64Mi, the instance will fail to initialize, and commands like `sqlplus` or internal health checks will fail with `ORA-01012: not logged on`. 

The fix (as shown in the YAML above) is to mount an `emptyDir` volume with `medium: Memory` to `/dev/shm`. Since this shared memory is backed by node RAM, it counts toward your pod's memory limits — ensure your `limits.memory` covers both the SGA and the PGA.
:::

Note the registry: pulling from `container-registry.oracle.com` requires accepting terms and an `imagePullSecret`. First startup builds the database — give the readiness probe a long leash or you'll kill it mid-`CREATE DATABASE`. See [ImagePullBackOff](/troubleshooting/imagepullbackoff/) if the pull itself fights you.

### Production-ish: OraOperator

Oracle ships an official operator, **OraOperator** (oracle-database-operator), whose `SingleInstanceDatabase` (SIDB) CR manages a containerized single-instance database — provisioning, cloning, patching, and standby (Data Guard) wiring via other CRs. As always, the CRD install is cluster-scoped: platform team request; you then create the CR:

```yaml
apiVersion: database.oracle.com/v1alpha1
kind: SingleInstanceDatabase
metadata:
  name: appdb
spec:
  edition: free                # or express / standard / enterprise (licensed!)
  image:
    pullFrom: container-registry.oracle.com/database/free:23.6.0.0
    pullSecrets: oracle-registry
  adminPassword:
    secretName: appdb-admin
  persistence:
    size: 100Gi
    storageClass: fast-ssd
  replicas: 1
```

Honest assessment: OraOperator is maintained and official, but its ecosystem maturity is a tier below CloudNativePG's — smaller community, fewer war stories to learn from, and RAC is not on the menu (Oracle's real HA stories remain Data Guard and RAC on dedicated infrastructure). Run [the operator-evaluation checklist](/stateful/operators-for-state/) on it with clear eyes.

### Hugepages and storage

Serious Oracle SGAs want hugepages, and on Kubernetes those are a **node-level** setting: the platform team must reserve them at the node (kernel boot/kubelet config); then you request them like any resource:

```yaml
resources:
  requests: { memory: 4Gi, hugepages-2Mi: 8Gi }
  limits:   { memory: 4Gi, hugepages-2Mi: 8Gi }
volumes:
  - name: hugepage
    emptyDir: { medium: HugePages-2Mi }
```

No hugepages on the nodes → pod stays `Pending`. Storage-wise Oracle is the most latency-sensitive thing you'll ever schedule: ask for the lowest-latency block StorageClass available and confirm what backs it ([Storage: PV, PVC, StorageClass](/stateful/storage-pv-pvc/)). NFS-backed volumes need Oracle-specific mount options — another reason this is a joint effort with platform.

## The usually-right answer: keep it off-cluster and connect

Most teams' Oracle "deployment" on Kubernetes should be connection plumbing. Two clean patterns:

**Pattern 1 — ExternalName Service** (DNS alias; good when the DB has a stable hostname):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: oracle-db
spec:
  type: ExternalName
  externalName: exadata-scan.corp.example.com
```

Your apps connect to `oracle-db.myapp.svc.cluster.local:1521` and DNS hands back a CNAME. Caveats: it's DNS-only — no ports, no proxying, no health checking — and TLS certificates must match the *real* hostname, not the alias.

**Pattern 2 — Service + manual EndpointSlice** (for IP-only targets, and it gives you a real cluster IP):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: oracle-db
spec:
  ports: [{ port: 1521, targetPort: 1521 }]
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: oracle-db-1
  labels:
    kubernetes.io/service-name: oracle-db
addressType: IPv4
ports: [{ port: 1521, protocol: TCP }]
endpoints:
  - addresses: ["10.20.30.40"]
```

Either way: keep credentials in a `Secret`, prefer a full TNS descriptor or Easy Connect string in config so DBAs can move the database without redeploying you, and check two failure modes up front — egress [NetworkPolicies](/networking/network-policies/) allowing 1521 outbound, and firewall rules on the database side allowing the cluster's egress IPs (a platform team question). The Service mechanics are covered in depth in [Services Deep Dive](/networking/services-deep-dive/).

:::tip[Connection storms after failover]
Oracle DBAs will notice if 40 pods all reconnect simultaneously after a network blip or a DB switchover. Configure your connection pool (UCP, HikariCP) with connection-establishment jitter/timeouts and sane max sizes. From the DBA's side, dead client detection (`SQLNET.EXPIRE_TIME`) keeps half-closed connections from pods that were OOM-killed from accumulating.
:::
