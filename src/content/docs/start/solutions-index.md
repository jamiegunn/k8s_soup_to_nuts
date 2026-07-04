---
title: "How Do I…? — Solutions Index"
description: A task-based index — route from what you're trying to do to the article that covers it.
sidebar:
  order: 9
---

Every article on this site, indexed by what you're trying to do rather than where it lives in the sidebar. Find your task below and click through. If something is on fire right now, skip all of this and start with the emergency box. For war stories and worked examples, browse [Field Notes](/blog/).

:::tip[On fire right now?]
Go straight to the [Troubleshooting Overview](/troubleshooting/overview/) for the symptom-to-playbook table, or [Emergency Playbooks](/operations/emergency-playbooks/) for full incident runbooks. First 60 seconds, in the affected namespace:

```bash
kubectl get pods -o wide
kubectl describe pod <pod-name>
kubectl get events --sort-by=.lastTimestamp
kubectl logs <pod-name> --previous
```
:::

## Deploy and release

| I want to… | Read |
|---|---|
| Understand what actually happens between `kubectl apply` and running pods | [Life of a Deployment](/start/life-of-a-deployment/) |
| Understand every field in my Deployment YAML | [Deployments Deep Dive](/workloads/deployments-deep-dive/) |
| Understand ReplicaSets and the pod-template-hash machinery | [Deployments Deep Dive](/workloads/deployments-deep-dive/) |
| Get CronJob timing right — missed runs, concurrency, deadlines | [Jobs and CronJobs](/workloads/jobs-and-cronjobs/) |
| Order startup with init containers (and debug Init:CrashLoopBackOff) | [Init and Sidecar Containers](/workloads/init-and-sidecar-containers/) |
| Understand the DaemonSets running under my pods (or run my own) | [DaemonSets](/workloads/daemonsets/) |
| Roll back a bad release, or unstick a stuck rollout | [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/) |
| Do a canary or blue-green release with plain labels | [Rollouts and Rollbacks](/workloads/rollouts-and-rollbacks/) |
| Stop my 2am fix being reverted by the 9am deploy | [Drift and CI/CD](/operations/drift-and-cicd/) |
| Hot-fix a live object safely when there's no time for the pipeline | [Live Patching](/operations/live-patching/) |
| Restart my pods without cutting a new release | [Restarts Without Redeploy](/operations/restarts-without-redeploy/) |
| Decide between Helm and Kustomize (or untangle the one I inherited) | [Helm and Kustomize](/operations/helm-and-kustomize/) |
| Move my team to GitOps without owning Argo/Flux | [GitOps for Tenants](/operations/gitops-for-tenants/) |
| Run a one-off migration or a nightly batch job | [Jobs and CronJobs](/workloads/jobs-and-cronjobs/) |
| Run setup steps or a helper container alongside my app | [Init and Sidecar Containers](/workloads/init-and-sidecar-containers/) |
| Control which nodes my pods land on (affinity, taints, spread) | [Scheduling](/workloads/scheduling/) |
| Fix manifests before an API version gets removed in the next upgrade | [API Deprecations](/operations/api-deprecations/) |

## Scale and stay up

| I want to… | Read |
|---|---|
| Autoscale on CPU/memory/custom metrics without replica thrash | [Autoscaling](/workloads/autoscaling/) |
| Survive node drains and cluster upgrades without an outage | [High Availability](/workloads/high-availability/) |
| Set requests and limits honestly (and understand QoS classes) | [Resources and QoS](/workloads/resources-and-qos/) |
| Right-size a service that's already in production, with data | [Resource Tuning in Prod](/operations/resource-tuning-in-prod/) |
| Write PromQL that answers "is this pod actually starved?" | [PromQL for Resources](/observability/promql-for-resources/) |
| Get startup/readiness/liveness probes right (and not cause outages with them) | [Health Checks](/workloads/health-checks/) |
| Keep replicas alive during voluntary disruptions (PDBs, graceful shutdown) | [High Availability](/workloads/high-availability/) |

## Configure my app

| I want to… | Read |
|---|---|
| Decide between env vars and mounted files, and make updates propagate | [Configuration](/workloads/configuration/) |
| Figure out why an env var isn't what I set (sources, precedence, expansion) | [Environment Variables](/workloads/environment-variables/) |
| Mount config as files without hitting the `subPath` update trap | [Config as Files](/workloads/config-files-and-volumes/) |
| Store secrets properly and keep them out of git | [Secrets](/workloads/secrets/) |
| Rotate a ConfigMap or Secret and have pods actually pick it up | [ConfigMap and Secret Rotation](/operations/configmap-secret-rotation/) |

## Debug a broken pod

| I want to… | Read |
|---|---|
| Triage methodically instead of guessing | [Triage Methodology](/troubleshooting/triage-methodology/) |
| Unstick a pod that's been `Pending` forever | [Pod Pending](/troubleshooting/pod-pending/) |
| Fix a container that starts, dies, restarts, repeat | [CrashLoopBackOff](/troubleshooting/crashloopbackoff/) |
| Fix `ImagePullBackOff` / `ErrImagePull` | [ImagePullBackOff](/troubleshooting/imagepullbackoff/) |
| Work out why my pod was killed with exit code 137 | [OOMKilled](/troubleshooting/oomkilled/) |
| Diagnose a pod stuck on a mount, or a PVC that won't attach | [Volume Failures](/troubleshooting/volume-failures/) |
| Find out what's behind my StorageClass (Longhorn, Ceph, Harvester…) | [Storage Controllers](/controllers/storage-controllers/) |
| Deploy a complete, tested build — golden service, zero-downtime, locked-down namespace, canary, KEDA, Valkey, PostgreSQL, IBM MQ, RabbitMQ, Kafka, front door | [Reference Architectures](/architectures/overview/) |
| Look up an exact error message and jump to its playbook | [Error Message Index](/troubleshooting/error-index/) |
| Follow a curated track instead of browsing 180 pages | [Learning Paths](/learning-paths/) |
| Build and ship a real Java API on my Mac, step by step (Lima + kind + Helm) | [Hands-On Labs](/labs/overview/) |
| Write HTTPRoutes on a platform-run Gateway | [Gateway API for App Teams](/networking/gateway-api/) |
| Finally understand L2/L4/L7 and what a VIP actually is | [Network Layers and VIPs](/networking/layers-and-vips/) |
| Trace one request end to end — DNS to VIP to pod and back | [Life of a Request](/routing/life-of-a-request/) |
| Find out which NAT ate my client IPs — and how to get them back | [SNAT and DNAT](/routing/nat/) |
| Understand what actually answers my DNS queries (and tune it) | [CoreDNS Deep Dive](/routing/coredns-deep-dive/) |
| Get a DNS record pointed at my service the right way | [DNS Integration](/routing/dns-integration/) |
| Write, template, and override Helm charts properly | [Helm Deep Dive](/helm/overview/) |
| Figure out which values file/flag wins in a Helm override fight | [Values and Overrides](/helm/values-and-overrides/) |
| Cut namespace cost without causing an OOM storm | [Cost and Rightsizing](/operations/cost-and-rightsizing/) |
| Request GPUs and keep a 40GB model load from killing the pod | [GPUs and AI Workloads](/workloads/gpu-and-ai-workloads/) |
| See every point where the JVM and Kubernetes interlock | [The JVM–Kubernetes Coupling Map](/java/jvm-kubernetes-coupling/) |
| Run .NET on Kubernetes — GC vs limits, dumps from runtime-only images | [.NET on Kubernetes](/dotnet/overview/) |
| Change log levels or pull a heap dump over HTTP — no redeploy, no JDK | [Actuator as an Ops Surface](/java/actuator/) |
| Get the actuator-style ops API for .NET (dumps, traces, collection rules) | [.NET Operational Endpoints](/dotnet/operational-endpoints/) |
| Add a sidecar the right way — log shipper, config reloader, secrets fetcher | [Sidecars](/sidecars/overview/) |
| Tune probe timings, JVM memory flags, or requests/limits with real numbers | [Knobs & Levers](/tuning/overview/) |
| Retrofit sane requests/limits onto a fleet that grew organically | [Requests & Limits on a Running Fleet](/tuning/brownfield-resources/) |
| Design health endpoints properly (and fix a fleet of bad probes safely) | [Health Check Design](/tuning/health-check-design/) |
| Stop dropping requests during deploys — the termination lifecycle | [Graceful Shutdown](/workloads/graceful-shutdown/) |
| Tune rollout pacing and the shutdown budget (surge, grace, preStop) | [Rollout & Shutdown Knobs](/tuning/rollout-shutdown-knobs/) |
| Decode a 502/503/504 from the front door, layer by layer | [502, 503, 504 from the Front Door](/troubleshooting/front-door-5xx/) |
| Size a new service from zero, step by step | [Sizing Walkthrough](/tuning/sizing-walkthrough/) |
| Tell whether it's my pod or the node (evictions, `Terminating`, `Unknown`) | [Node Problems](/troubleshooting/node-problems/) |
| Shell into a distroless container, or debug one that dies before I can exec | [Debugging Toolbox](/troubleshooting/debugging-toolbox/) |
| Get a full Unix toolkit into a shell-less pod with one tiny image | [The BusyBox Toolkit](/troubleshooting/busybox/) |
| Read /proc and cgroup files like a pro once I'm exec'd in | [Linux Inside the Pod](/troubleshooting/linux-inside-the-pod/) |
| Build CI on GitHub Actions + Artifactory — templates, charts, tests | [CI with GitHub & Artifactory](/ci/overview/) |
| Test my Helm chart in CI (units, rendered manifests, ephemeral k3d) | [Testing in CI](/ci/testing-in-ci/) |
| Find out why my pods never appear even though the Deployment applied | [Pod Security](/workloads/pod-security/) |

## Debug networking and traffic

| I want to… | Read |
|---|---|
| Fix "the service is down" — connection refused, timeouts, 502/503 | [Service Unreachable](/troubleshooting/service-unreachable/) |
| Trace a request hop by hop with the right tools at each layer | [Debugging the Network](/networking/debugging-network/) |
| Fix `no such host` and other DNS lookup failures | [DNS](/networking/dns/) |
| Understand Services, endpoints, and why my selector matches nothing | [Services Deep Dive](/networking/services-deep-dive/) |
| Expose my app on a hostname and path (and debug the Ingress when it 404s) | [Ingress and Routing](/networking/ingress-and-routing/) |
| Tune ingress-nginx — timeouts, body size, gRPC, canary releases | [ingress-nginx in Practice](/networking/ingress-nginx/) |
| Expose a database, queue, or other raw TCP/UDP service outside the cluster | [TCP and Non-HTTP Ingress](/networking/tcp-ingress/) |
| Work out why pod A can reach a service but pod B can't | [Network Policies](/networking/network-policies/) |
| Get traffic in from outside the cluster (LoadBalancer, NodePort) | [External Load Balancing](/networking/external-load-balancing/) |
| Find out why only one gRPC pod is hot while its siblings idle | [Long-Lived Connections](/networking/long-lived-connections/) |
| Keep WebSockets and streaming connections alive through rollouts | [Long-Lived Connections](/networking/long-lived-connections/) |
| Understand what the sidecar/mesh the platform team installed is doing to my traffic | [Service Mesh](/networking/service-mesh/) |
| Get how a LoadBalancer Service actually gets an IP on bare metal | [MetalLB](/controllers/metallb/) |
| Understand how the F5 in front of my cluster learns about my Services | [F5 CIS](/controllers/f5-cis/) |
| Build a correct mental model of pod IPs, NAT-free flat networking | [The Networking Model](/networking/networking-model/) |
| Get the lay of the whole networking stack first | [Networking Overview](/networking/overview/) |

## Java and JVM work

| I want to… | Read |
|---|---|
| Get a thread dump from a JRE-only pod (no jstack, no jcmd) | [Thread Dumps, JRE-Only](/java/thread-dumps-jre-only/) |
| Get a heap dump from a JRE-only pod | [Heap Dumps, JRE-Only](/java/heap-dumps-jre-only/) |
| Copy dumps out of a pod (or off a dead one) | [Getting Dumps Out](/java/getting-dumps-out/) |
| Attach a remote debugger to a JVM running in the cluster | [Remote Debugging](/java/remote-debugging/) |
| Size heap vs container limit so the JVM stops getting OOMKilled | [JVM in Containers](/java/jvm-in-containers/) |
| Hunt a memory leak, or decode `OutOfMemoryError` vs `OOMKilled` | [Memory Leaks and OOM](/java/memory-leaks-and-oom/) |
| Pick and tune a GC for container-sized heaps | [GC and Performance](/java/gc-and-performance/) |
| Export JVM metrics, and see GC/heap/threads in Grafana | [Java Observability](/java/java-observability/) |
| Wire Spring Boot's actuator, probes, and graceful shutdown into Kubernetes | [Spring Boot](/java/spring-boot/) |
| Start with the JVM-on-Kubernetes big picture | [Java Overview](/java/overview/) |

## Run stateful services

| I want to… | Read |
|---|---|
| Understand StatefulSets — stable identity, ordered startup, per-pod storage | [StatefulSets Fundamentals](/stateful/statefulsets-fundamentals/) |
| Get persistent storage: PVs, PVCs, StorageClasses, expansion | [Storage: PV and PVC](/stateful/storage-pv-pvc/) |
| Understand how storage actually attaches to nodes (and who owns it) | [CSI Drivers](/controllers/csi-drivers/) |
| Run Valkey/Redis as a cache or store in-cluster | [Valkey and Redis](/stateful/valkey-and-redis/) |
| Run PostgreSQL in Kubernetes without regretting it | [PostgreSQL](/stateful/postgresql/) |
| Connect to (or reluctantly run) Oracle from the cluster | [Oracle](/stateful/oracle/) |
| Run Kafka/RabbitMQ/other brokers on Kubernetes | [Message Queues](/stateful/message-queues/) |
| Use an operator to run my database instead of hand-rolling it | [Operators for State](/stateful/operators-for-state/) |
| Back up my data and have a disaster-recovery story | [Backup and DR](/stateful/backup-and-dr/) |
| Decide whether my workload even belongs in a StatefulSet | [Stateful Overview](/stateful/overview/) |

## Watch and measure

| I want to… | Read |
|---|---|
| Write logs Kubernetes-natively (stdout, structure, correlation) | [Logging Fundamentals](/observability/logging-fundamentals/) |
| Understand where my logs go after stdout, and why some go missing | [Log Collection](/observability/log-collection/) |
| Expose metrics and get them scraped by Prometheus | [Metrics](/observability/metrics/) |
| Use events as a debugging timeline (and keep them past the 1-hour TTL) | [Events](/observability/events/) |
| Trace a request across services to find the slow hop | [Tracing](/observability/tracing/) |
| Investigate "it's slow" — latency, throttling, saturation | [Performance Analysis](/observability/performance-analysis/) |
| Write alerts that page on symptoms, not noise | [Alerting](/observability/alerting/) |
| Plan my observability stack top to bottom | [Observability Overview](/observability/overview/) |

## Work the platform relationship

| I want to… | Read |
|---|---|
| Understand exactly what I can and can't do without cluster admin | [Working Without Admin](/start/working-without-admin/) |
| Decode Roles, RoleBindings, and what my kubeconfig actually grants | [RBAC Explained](/start/rbac-explained/) |
| Fix `Error from server (Forbidden)` — for me or for my app's ServiceAccount | [RBAC Denied](/troubleshooting/rbac-denied/) |
| Let my pods call the Kubernetes API or cloud services without static keys | [ServiceAccounts](/workloads/serviceaccounts/) |
| Escalate to the platform team with evidence they'll act on fast | [Working with the Platform Team](/operations/working-with-platform-team/) |
| Find out why the cluster rejected (or silently mutated) my manifest | [Admission Webhooks](/controllers/admission-webhooks/) |
| Survive a cluster upgrade with zero surprises | [High Availability](/workloads/high-availability/) and [API Deprecations](/operations/api-deprecations/) |
| See everything in the day-2 operations toolbox | [Operations Overview](/operations/overview/) |

## Level up with kubectl

| I want to… | Read |
|---|---|
| Learn the 20 commands that cover 95% of daily work | [kubectl Survival Kit](/start/kubectl-survival-kit/) |
| Understand what kubectl actually does (kubeconfig, contexts, the API) | [How kubectl Works](/kubectl/how-kubectl-works/) |
| Extract exactly the field I need — jsonpath, custom-columns, `-o` tricks | [Output and Queries](/kubectl/output-and-queries/) |
| Steal aliases, plugins, and shell tricks from people who live in kubectl | [Tips and Tricks](/kubectl/tips-and-tricks/) |
| Get the map of the whole kubectl section | [kubectl Overview](/kubectl/overview/) |

## Build and secure the pipeline

| I want to… | Read |
|---|---|
| Design a CI/CD pipeline that builds, tests, and deploys to the cluster | [CI/CD Pipeline Design](/operations/cicd-pipeline-design/) |
| Sign images, scan for CVEs, and pin what actually runs | [Supply Chain Security](/operations/supply-chain-security/) |
| Harden pods — securityContext, non-root, Pod Security Standards | [Pod Security](/workloads/pod-security/) |
| Run a realistic Kubernetes on my laptop for the inner loop | [Local Development](/start/local-development/) |

## Learn the fundamentals

| I want to… | Read |
|---|---|
| Start at the beginning — what this guide is and how to use it | [Start Here](/start/overview/) |
| Build the mental model: control plane, nodes, desired state | [How Kubernetes Works](/start/how-kubernetes-works/) |
| Get YAML, labels, selectors, and namespaces straight once and for all | [YAML, Labels, and Namespaces](/start/yaml-labels-and-namespaces/) |
| Understand Deployments → ReplicaSets → Pods and why hand-fixes never stick | [Workloads Overview](/workloads/overview/) |
| Grok the reconciliation loop that drives every controller | [Reconciliation](/controllers/reconciliation/) |
| Understand CRDs — why `kubectl get` knows about resources the docs don't | [CRDs Explained](/controllers/crds-explained/) |
| Understand operators — controllers that run software for you | [Operators](/controllers/operators/) |
| See which controllers are running in a typical tenant cluster | [Controllers Overview](/controllers/overview/) |

Can't find your task? The section overviews each have their own symptom and topic tables — start with [Troubleshooting](/troubleshooting/overview/) for anything broken, or browse [Field Notes](/blog/) for longer-form walkthroughs.
