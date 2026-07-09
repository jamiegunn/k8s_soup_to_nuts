---
title: Timed Drills
description: Thirteen exam-style CKAD tasks with par times, setup, verification commands, and full solutions — 75 minutes of par covering every task archetype; three clean rounds means you're ready.
keywords:
  - CKAD practice questions with solutions
  - timed kubernetes exam drills
  - CKAD practice tasks free
  - create pod deployment job cronjob drill
  - network policy practice task solution
  - RBAC serviceaccount role rolebinding drill
  - configmap secret env volume practice
  - am i ready for the CKAD test
sidebar:
  order: 5
---

Thirteen tasks, written the way the exam writes them, each with a **par time** calibrated to exam pace. Total par: 75 minutes — roughly the working time a real CKAD gives you after reading and context switches. Do them against your own cluster ([Lab 0](/labs/lab-0-cluster/) or any [local cluster](/start/local-development/)).

**The rules — they're the point:**

1. **Timer on, per drill.** Note your time. Over par is fine early; the trend is what matters.
2. **Solve before you peek.** Each solution is collapsed. Opening it before your attempt converts a drill into a worked example — useful once, but score it as a miss.
3. **Grade the end state**, exactly like the exam: run the verification commands. "Almost" is a miss.
4. **Use only exam resources:** `kubernetes.io/docs`, `helm.sh/docs`, and `kubectl explain`. No Stack Overflow, no AI, no this-site tabs during the timer.
5. **Three rounds across your [study plan](/ckad/study-plan/).** Round 1 will hurt. Round 3 should be boring. Boring passes exams.

**Scoring a round:** each drill correct-within-par = 1 point, correct-but-slow (≤1.5× par) = ½. **≥10/13 means you're exam-ready**; 7–10 means drill the misses; below 7, revisit the [domain map](/ckad/exam-domains/) links for what missed.

## Setup

Run once before each round (idempotent; re-running resets nothing you need):

```bash
kubectl create namespace drills --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace drills-q --dry-run=client -o yaml | kubectl apply -f -

# Drill 4 fixture: a deliberately broken deployment
kubectl -n drills create deploy shop --image=nginx:1.99-doesnotexist --dry-run=client -o yaml | kubectl apply -f -

# Drill 7 fixture: a plain deployment awaiting probes
kubectl -n drills create deploy web-probe --image=nginx:1.27 --dry-run=client -o yaml | kubectl apply -f -

# Drill 12 fixture: a quota-constrained namespace
kubectl -n drills-q create quota team-quota --hard=pods=2,requests.cpu=1,limits.memory=1Gi --dry-run=client -o yaml | kubectl apply -f -
```

And full teardown between rounds:

```bash
kubectl delete namespace drills drills-q --wait=false
```

---

## Drill 1 — The imperative pod · par 2:00

> In namespace `drills`, create a pod named `web` running image `nginx:1.27`, labeled `tier=frontend`, with environment variable `MODE=prod`.

**Verify:** `kubectl -n drills get pod web --show-labels` shows `Running` and `tier=frontend`; `kubectl -n drills exec web -- printenv MODE` prints `prod`.

<details>
<summary>Solution</summary>

One line — no YAML file needed:

```bash
kubectl -n drills run web --image=nginx:1.27 --labels=tier=frontend --env=MODE=prod
```

If you wrote YAML for this, reread [Speed System Part 1](/ckad/speed-system/#part-1-generate--never-type-boilerplate). Par exists to force the generator habit.

</details>

## Drill 2 — The sidecar logger · par 7:00

> In namespace `drills`, create a pod `logger` with two containers sharing an `emptyDir` volume mounted at `/var/log/app` in both: container `app` (`busybox:1.36`) appends the date to `/var/log/app/app.log` every 5 seconds; container `tailer` (`busybox:1.36`) runs `tail -F /var/log/app/app.log`.

**Verify:** `kubectl -n drills logs logger -c tailer` shows timestamps arriving.

<details>
<summary>Solution</summary>

Scaffold one container, add the second and the volume by hand:

```bash
kubectl -n drills run logger --image=busybox:1.36 --dry-run=client -o yaml \
  -- sh -c 'while true; do date >> /var/log/app/app.log; sleep 5; done' > logger.yaml
```

Edit to:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: logger
  namespace: drills
spec:
  volumes:
  - name: logs
    emptyDir: {}
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "while true; do date >> /var/log/app/app.log; sleep 5; done"]
    volumeMounts:
    - name: logs
      mountPath: /var/log/app
  - name: tailer
    image: busybox:1.36
    command: ["sh", "-c", "tail -F /var/log/app/app.log"]
    volumeMounts:
    - name: logs
      mountPath: /var/log/app
```

The exam version sometimes asks for a *restartable init container* (a native sidecar: `initContainers` entry with `restartPolicy: Always`) — know both shapes: [Init & Sidecar Containers](/workloads/init-and-sidecar-containers/).

</details>

## Drill 3 — The disciplined CronJob · par 6:00

> In namespace `drills`, create a CronJob `cleanup` (image `busybox:1.36`, command `echo clean`) that runs every 15 minutes, never runs two instances concurrently, keeps 3 successful job histories, and kills any run exceeding 60 seconds.

**Verify:** `kubectl -n drills get cronjob cleanup -o yaml | grep -E 'schedule|concurrencyPolicy|successfulJobsHistoryLimit|activeDeadlineSeconds'` shows all four; a manual run completes: `kubectl -n drills create job --from=cronjob/cleanup manual && kubectl -n drills get job manual`.

<details>
<summary>Solution</summary>

```bash
kubectl -n drills create cronjob cleanup --image=busybox:1.36 \
  --schedule='*/15 * * * *' --dry-run=client -o yaml -- echo clean > cj.yaml
```

Add the three fields the generator can't set (`kubectl explain cronjob.spec` confirms where each lives — two are CronJob-level, one is Job-level):

```yaml
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  jobTemplate:
    spec:
      activeDeadlineSeconds: 60
      template:
        spec:
          containers:
          - name: cleanup
            image: busybox:1.36
            command: ["echo", "clean"]
          restartPolicy: OnFailure
```

The placement of `activeDeadlineSeconds` (inside `jobTemplate.spec`, *not* next to `schedule`) is the actual test. Deep dive: [Jobs & CronJobs](/workloads/jobs-and-cronjobs/).

</details>

## Drill 4 — Fix the broken deployment · par 4:00

> Deployment `shop` in namespace `drills` is failing. Diagnose the cause and fix it so all replicas are Ready. The application should run `nginx:1.27`.

**Verify:** `kubectl -n drills rollout status deploy/shop` reports success.

<details>
<summary>Solution</summary>

Triage order, not guessing (this is [Triage Methodology](/troubleshooting/triage-methodology/) in miniature):

```bash
kubectl -n drills get pods                        # STATUS: ImagePullBackOff
kubectl -n drills describe pod -l app=shop | tail  # Failed to pull image "nginx:1.99-doesnotexist"
kubectl -n drills set image deploy/shop nginx=nginx:1.27
kubectl -n drills rollout status deploy/shop      # successfully rolled out
```

Exam debugging tasks are almost always one of four causes: bad image ([ImagePullBackOff](/troubleshooting/imagepullbackoff/)), bad command/config ([CrashLoopBackOff](/troubleshooting/crashloopbackoff/)), missing ConfigMap/Secret, or an unsatisfiable probe. `describe` names which in one screen.

</details>

## Drill 5 — Update and roll back · par 5:00

> In namespace `drills`, create deployment `api` with image `nginx:1.26` and 3 replicas. Update it to `nginx:1.27` and confirm the rollout completes. Then roll it back and confirm the running image is `nginx:1.26` again.

**Verify:** `kubectl -n drills get deploy api -o jsonpath='{.spec.template.spec.containers[0].image}'` prints `nginx:1.26`; `kubectl -n drills rollout history deploy/api` shows ≥3 revisions.

<details>
<summary>Solution</summary>

```bash
kubectl -n drills create deploy api --image=nginx:1.26 --replicas=3
kubectl -n drills rollout status deploy/api
kubectl -n drills set image deploy/api nginx=nginx:1.27
kubectl -n drills rollout status deploy/api
kubectl -n drills rollout undo deploy/api
kubectl -n drills rollout status deploy/api
kubectl -n drills get deploy api -o jsonpath='{.spec.template.spec.containers[0].image}'
```

Why `undo` creates a *new* revision rather than rewinding, and when `--to-revision` matters: [Rollouts & Rollbacks](/workloads/rollouts-and-rollbacks/).

</details>

## Drill 6 — Config every way · par 7:00

> In namespace `drills`: create ConfigMap `app-config` with key `LOG_LEVEL=debug` and Secret `db-pass` with key `password=S3cret!`. Create pod `config-pod` (`busybox:1.36`, `sleep 3600`) that exposes `LOG_LEVEL` from the ConfigMap as an env var, and mounts the Secret at `/etc/creds` (read-only).

**Verify:** `kubectl -n drills exec config-pod -- printenv LOG_LEVEL` → `debug`; `kubectl -n drills exec config-pod -- cat /etc/creds/password` → `S3cret!`.

<details>
<summary>Solution</summary>

```bash
kubectl -n drills create cm app-config --from-literal=LOG_LEVEL=debug
kubectl -n drills create secret generic db-pass --from-literal=password='S3cret!'
kubectl -n drills run config-pod --image=busybox:1.36 --dry-run=client -o yaml -- sleep 3600 > cp.yaml
```

Edit the pod spec:

```yaml
spec:
  volumes:
  - name: creds
    secret:
      secretName: db-pass
  containers:
  - name: config-pod
    image: busybox:1.36
    command: ["sleep", "3600"]
    env:
    - name: LOG_LEVEL
      valueFrom:
        configMapKeyRef:
          name: app-config
          key: LOG_LEVEL
    volumeMounts:
    - name: creds
      mountPath: /etc/creds
      readOnly: true
```

`valueFrom.configMapKeyRef` vs `envFrom` vs volume mounts — all the consumption modes and when each updates: [Environment Variables](/workloads/environment-variables/) and [Config Files & Volumes](/workloads/config-files-and-volumes/). [Lab 2](/labs/lab-2-config-and-secrets/) drills every one of them.

</details>

## Drill 7 — Probes with exact fields · par 6:00

> Add to deployment `web-probe` in namespace `drills`: a readiness probe (HTTP GET `/` on port 80, first check after 3s, then every 5s) and a liveness probe (TCP socket on port 80, every 10s, restart after 3 consecutive failures).

**Verify:** `kubectl -n drills describe pod -l app=web-probe | grep -E 'Liveness|Readiness'` shows both with the right numbers; pods are `READY 1/1`.

<details>
<summary>Solution</summary>

`kubectl -n drills edit deploy web-probe`, adding under the container:

```yaml
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 3
          periodSeconds: 5
        livenessProbe:
          tcpSocket:
            port: 80
          periodSeconds: 10
          failureThreshold: 3
```

Field names blank? `kubectl explain deploy.spec.template.spec.containers.livenessProbe --recursive` lists every one — faster than the docs tab. What the fields actually mean (and the timing math behind sane values): [Health Check Knobs](/tuning/health-check-knobs/).

</details>

## Drill 8 — The locked-down pod · par 5:00

> In namespace `drills`, create pod `secure-pod` (`busybox:1.36`, `sleep 3600`) that runs as user 1000 and group 3000, with privilege escalation disallowed and all capabilities dropped.

**Verify:** `kubectl -n drills exec secure-pod -- id` → `uid=1000 gid=3000`.

<details>
<summary>Solution</summary>

Scaffold with `run --dry-run=client -o yaml`, then:

```yaml
spec:
  securityContext:            # pod level: user/group
    runAsUser: 1000
    runAsGroup: 3000
  containers:
  - name: secure-pod
    image: busybox:1.36
    command: ["sleep", "3600"]
    securityContext:          # container level: escalation, capabilities
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
```

Knowing which field lives at pod level vs container level *is* the task — `runAsUser` works at either; `capabilities` and `allowPrivilegeEscalation` are container-only. Map: [Pod Security](/workloads/pod-security/).

</details>

## Drill 9 — The NetworkPolicy · par 8:00

> In namespace `drills`, pods labeled `app=db` must accept ingress traffic **only** from pods labeled `app=api` in the same namespace, and only on TCP port 5432. All other ingress to those pods must be denied.

**Verify:** `kubectl -n drills describe netpol db-allow-api` shows the selector, the from-clause, and the port. Selector sanity: `kubectl -n drills get pods -l app=db` (a policy selecting zero pods "passes" and does nothing). Functional check if you have test pods: an `app=api` pod can reach `db:5432`; an unlabeled pod can't.

<details>
<summary>Solution</summary>

No generator exists — copy the skeleton from the [NetworkPolicy docs](https://kubernetes.io/docs/concepts/services-networking/network-policies/) and edit:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-allow-api
  namespace: drills
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: api
    ports:
    - protocol: TCP
      port: 5432
```

The deny-everything-else is implicit: once *any* policy selects a pod for Ingress, all non-matching ingress is denied. The classic trap is list structure — `podSelector` and `namespaceSelector` as **one list item** means AND; as **two items** means OR, a one-character diff that inverts the security posture: [Network Policies](/networking/network-policies/). (Enforcement note: k3s enforces NetworkPolicy out of the box; kind's default CNI does **not** — describe-level verification is all you can do there.)

</details>

## Drill 10 — Service + Ingress · par 7:00

> In namespace `drills`, expose deployment `shop` (fixed in Drill 4) as a ClusterIP Service `shop-svc` on port 8080 targeting container port 80. Then create Ingress `shop-ing` routing host `shop.local`, path `/` (Prefix), to that Service.

**Verify:** `kubectl -n drills get endpoints shop-svc` is **non-empty** (the real test); `kubectl -n drills describe ingress shop-ing` shows host, path, and `shop-svc:8080`.

<details>
<summary>Solution</summary>

```bash
kubectl -n drills expose deploy shop --name=shop-svc --port=8080 --target-port=80
kubectl -n drills create ingress shop-ing --rule="shop.local/*=shop-svc:8080"
kubectl -n drills get endpoints shop-svc     # must list pod IPs
```

Empty endpoints = selector/label mismatch, the most common silent failure in exam networking tasks (and in production — same debugging: [Service Unreachable](/troubleshooting/service-unreachable/)). `port` vs `targetPort` confusion is the runner-up: [Services Deep Dive](/networking/services-deep-dive/).

</details>

## Drill 11 — RBAC end to end · par 6:00

> In namespace `drills`: create ServiceAccount `reporter`, a Role `pod-reader` permitting only `get` and `list` on pods, and a RoleBinding granting the Role to that ServiceAccount. Prove it works — and prove it grants nothing more.

**Verify:** `kubectl -n drills auth can-i list pods --as=system:serviceaccount:drills:reporter` → `yes`; `... auth can-i delete pods --as=...` → `no`.

<details>
<summary>Solution</summary>

Three generators and two proof commands — zero YAML:

```bash
kubectl -n drills create sa reporter
kubectl -n drills create role pod-reader --verb=get,list --resource=pods
kubectl -n drills create rolebinding reporter-binding \
  --role=pod-reader --serviceaccount=drills:reporter
kubectl -n drills auth can-i list pods   --as=system:serviceaccount:drills:reporter   # yes
kubectl -n drills auth can-i delete pods --as=system:serviceaccount:drills:reporter   # no
```

The `--as=system:serviceaccount:<namespace>:<name>` impersonation string is worth memorizing exactly — it turns every RBAC task self-verifying. Why the pieces fit this way: [RBAC Explained](/start/rbac-explained/).

</details>

## Drill 12 — Fitting the quota · par 6:00

> Namespace `drills-q` has a ResourceQuota (2 pods, 1 CPU of requests, 1Gi of limits.memory). Create deployment `quota-app` there: 2 replicas of `busybox:1.36` running `sleep 3600`, each with requests `cpu=200m, memory=128Mi` and limits `cpu=500m, memory=256Mi`. Both replicas must be Running.

**Verify:** `kubectl -n drills-q get deploy quota-app` shows `2/2`; `kubectl -n drills-q describe quota team-quota` shows usage within limits.

<details>
<summary>Solution</summary>

```bash
kubectl -n drills-q create deploy quota-app --image=busybox:1.36 --replicas=2 \
  --dry-run=client -o yaml -- sleep 3600 > qa.yaml
vim qa.yaml    # add resources under the container
kubectl apply -f qa.yaml
```

```yaml
        resources:
          requests:
            cpu: 200m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
```

The trap: in a quota'd namespace, pods **without** requests/limits set are rejected outright — and the rejection hides in the ReplicaSet's events (`kubectl -n drills-q describe rs`), not the Deployment's. If your pods silently don't appear, that's where the answer is: [Resources & QoS](/workloads/resources-and-qos/) and [Working Without Admin](/start/working-without-admin/).

</details>

## Drill 13 — PVC and mount · par 6:00

> In namespace `drills`, create a PersistentVolumeClaim `data-pvc` requesting 100Mi with access mode ReadWriteOnce (default StorageClass). Create pod `writer` (`busybox:1.36`) mounting it at `/data` and running `sh -c 'echo hello > /data/proof; sleep 3600'`.

**Verify:** `kubectl -n drills get pvc data-pvc` shows `Bound`; `kubectl -n drills exec writer -- cat /data/proof` → `hello`.

<details>
<summary>Solution</summary>

No PVC generator — the docs block is 8 lines (search "persistent volume claim"):

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-pvc
  namespace: drills
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 100Mi
```

Pod (scaffold with `run`, add volume):

```yaml
spec:
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: data-pvc
  containers:
  - name: writer
    image: busybox:1.36
    command: ["sh", "-c", "echo hello > /data/proof; sleep 3600"]
    volumeMounts:
    - name: data
      mountPath: /data
```

A PVC stuck `Pending` on a local cluster usually means `WaitForFirstConsumer` binding — it binds when the pod arrives, so create the pod before diagnosing. The full lifecycle: [Storage: PV & PVC](/stateful/storage-pv-pvc/).

</details>

---

## After each round

Log three numbers: score (out of 13), total time vs the 75-minute par, and which drills missed. The [study plan](/ckad/study-plan/) schedules rounds at the end of weeks 2, 3, and 4 — the week-4 round plus a strong second [killer.sh](https://killer.sh/) session is the green light. Misses route back through the [domain map](/ckad/exam-domains/); slow-but-correct routes back through the [speed system](/ckad/speed-system/) and [Vim guide](/kubectl/vim-for-ckad/).
