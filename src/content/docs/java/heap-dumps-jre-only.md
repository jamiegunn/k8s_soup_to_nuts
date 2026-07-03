---
title: Heap Dumps with a JRE Only
description: Five ways to capture a JVM heap dump from a Kubernetes pod without jmap — automatic on OOM, jattach, ephemeral JDK containers, JMX, and Actuator.
sidebar:
  order: 4
---

A heap dump is the definitive answer to "what is filling memory": every
object, every field, every reference chain. It's also the most expensive
evidence to collect — the JVM pauses fully while writing it, and the file is
roughly the size of the used heap. Get the cheap alternatives (histograms)
into your habits, and get the automatic-on-OOM dump configured *before* you
need it.

## Option 0 (do this today): dump automatically on OutOfMemoryError

Works on every HotSpot JVM ever shipped, JRE or JDK:

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:+HeapDumpOnOutOfMemoryError
      -XX:HeapDumpPath=/dumps
      -XX:+ExitOnOutOfMemoryError
volumeMounts:
  - name: dumps
    mountPath: /dumps
volumes:
  - name: dumps
    emptyDir:
      sizeLimit: 4Gi
```

When the heap fills, the JVM writes
`/dumps/java_pid7.hprof` *before* anything else happens, then
(`ExitOnOutOfMemoryError`) exits so Kubernetes restarts the pod cleanly.

:::danger[Point HeapDumpPath at a volume, not the container filesystem]
Two failure modes if you don't. (1) The dump lands on the container's
writable layer, counts against **ephemeral storage**, and a 6 GiB dump gets
your pod *evicted* — taking the dump with it. (2) The container restarts
after the OOM (it will) and the writable layer is reset — dump gone. An
`emptyDir` survives container restarts within the pod; a PVC survives even
pod replacement. Size it: **dump ≈ used heap**, so an `emptyDir` for a 4 GiB
heap needs ~4–5 GiB, and check with your platform team whether emptyDirs
are backed by node disk that counts toward eviction thresholds.
:::

Also useful: `-XX:HeapDumpPath=/dumps/oom-%p.hprof` embeds the pid; the JVM
refuses to overwrite an existing file, so clean old dumps out or the *next*
OOM captures nothing.

## Option 1: jcmd GC.heap_dump — if jdk.jcmd shipped

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- jcmd 7 GC.heap_dump /dumps/manual-$(date +%s).hprof
```

Only if `java --list-modules | grep jdk.jcmd` says so (see the
[inventory checks](/java/overview/)). Add `-all` to include unreachable objects
(default dumps only live objects, which implies a full GC first).

## Option 2: jattach dumpheap — the JRE-only workhorse

[jattach](https://github.com/jattach/jattach) is a static binary (~50 KB)
that speaks the dynamic attach protocol. Three ways to get it into the pod:

```bash
# (a) kubectl cp — requires tar in the image
kubectl cp ./jattach myapp-7d4b9c6f5d-x2klm:/tmp/jattach

# (b) fetch from your artifact repo, if the image has wget/curl
kubectl exec myapp-7d4b9c6f5d-x2klm -- wget -O /tmp/jattach \
  https://artifacts.internal.example.com/tools/jattach && \
kubectl exec myapp-7d4b9c6f5d-x2klm -- chmod +x /tmp/jattach

# (c) best: bake it into the image at build time
#   COPY --from=ghcr.io/jattach/jattach:v2.2 /jattach /usr/local/bin/jattach
```

Then:

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- /tmp/jattach 7 dumpheap /dumps/manual.hprof
```

```console
Connected to remote JVM
JVM response code = 0
Dumping heap to /dumps/manual.hprof ...
Heap dump file created [1287346521 bytes in 8.417 secs]
```

The path is interpreted by the *JVM*, so it must be writable by the JVM's
user, inside the JVM's mount namespace — your `/dumps` volume. jattach must
run as the same UID as the JVM (automatic when you `kubectl exec` in).
Pull binaries only from a repo you control, and verify checksums.

jattach also does `jcmd` passthrough, so everything in Option 1 works:
`/tmp/jattach 7 jcmd "GC.heap_dump /dumps/x.hprof"`.

## Option 3: ephemeral JDK container + jmap

For distroless images with no shell, share the process namespace with a
JDK-equipped ephemeral container:

```bash
kubectl debug -it myapp-7d4b9c6f5d-x2klm \
  --image=eclipse-temurin:21-jdk --target=myapp -- bash
```

```bash
# inside the debug container — attach needs the SAME UID as the JVM:
ps -o pid,user,comm -e | grep java     # note pid (say 7) and user (say uid 1000)
setpriv --reuid=1000 --regid=1000 --clear-groups \
  jmap -dump:live,format=b,file=/proc/7/root/dumps/manual.hprof 7
```

Two path subtleties: the ephemeral container has its *own* filesystem, but
the JVM writes the dump in *its* namespace — so either target a path that
exists for the JVM (`/dumps` on the shared volume, reachable from the debug
side as `/proc/7/root/dumps/`), or mount the same volume into the debug
container. Writing to `/proc/7/root/...` from the tool side works because
modern JDK attach resolves paths relative to the target. If attach fails
with "Unable to open socket file", it's almost always the UID mismatch above
— same caveats as in [thread dumps](/java/thread-dumps-jre-only/), including
`jps` being blind across namespaces (attach by pid from `ps`).

## Option 4: JMX + port-forward (no exec at all)

If the app already exposes JMX (many do for metrics):

```bash
kubectl port-forward myapp-7d4b9c6f5d-x2klm 9010:9010
# then in jconsole/VisualVM on your machine, connect to localhost:9010,
# MBean com.sun.management:type=HotSpotDiagnostic → operation dumpHeap
#   p0: /dumps/jmx.hprof   p1: true (live objects only)
```

The `HotSpotDiagnosticMXBean.dumpHeap` operation writes the file **inside
the container**, not to your laptop — you still need
[getting dumps out](/java/getting-dumps-out/). Enabling JMX *for* this requires
a flag change and restart (`-Dcom.sun.management.jmxremote.port=9010
-Dcom.sun.management.jmxremote.authenticate=false
-Dcom.sun.management.jmxremote.ssl=false
-Djava.rmi.server.hostname=127.0.0.1
-Dcom.sun.management.jmxremote.rmi.port=9010`) — only sane because
port-forward means it's never exposed off-pod, but treat unauthenticated JMX
as a loaded gun and don't put it in the base profile.

**Spring Boot shortcut:** if Actuator's `heapdump` endpoint is enabled,
`kubectl port-forward` + `curl -o heap.hprof localhost:8081/actuator/heapdump`
captures *and* downloads in one step. Easiest path of all when available —
gate that endpoint carefully in your Service/ingress config.

## Cheaper first: the class histogram

A full dump pauses the JVM for seconds and produces gigabytes. A histogram
pauses briefly and produces a few kilobytes of text — often enough to name
the leak:

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- /tmp/jattach 7 jcmd GC.class_histogram | head -15
```

```console
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:      14038211      897645504  [B (java.base@21.0.5)
   2:      13990102      335762448  java.lang.String (java.base@21.0.5)
   3:       2101877      201780192  com.example.orders.OrderSnapshot
   4:       2101877       84075080  java.util.HashMap$Node (java.base@21.0.5)
```

2.1 million `OrderSnapshot` instances is a lead you can take straight to the
code. Capture a histogram every few minutes and diff: the classes whose
counts only ever go up are your suspects. This is the core of the leak
workflow in [Memory leaks and OOM](/java/memory-leaks-and-oom/).

## Operational realities

- **Pause:** the JVM is completely stopped while dumping — seconds per GiB
  (mostly disk-bound). In-flight requests stall; readiness probes can fail. If
  the pod is behind a Service with healthy replicas, that's fine; if it's the
  last healthy replica, think twice, or dump the *least* loaded pod — leaks
  usually appear in all replicas.
- **Size:** dump ≈ used heap (live-only dumps somewhat less). An 8 GiB heap
  at 80% is a ~6 GiB file. Plan volume space, transfer time (see
  [Getting dumps out](/java/getting-dumps-out/)), and clean up afterwards.
- **Sensitive data:** a heap dump contains *everything in memory* —
  passwords, tokens, PII, customer payloads. Treat `.hprof` files like
  production database exports: encrypted transfer, restricted storage,
  deletion after analysis. Some orgs require sign-off before pulling one off
  the cluster. Know your policy before the incident.

## Analyzing: Eclipse MAT in three moves

Open the `.hprof` in [Eclipse Memory Analyzer](https://eclipse.dev/mat/)
(give MAT its own `-Xmx` bigger than the dump; analysis of a 6 GiB dump wants
8 GiB+ locally).

1. **Leak Suspects report** — the auto-generated first pass; right
   embarrassingly often ("one instance of `QueryCache` occupies 71.3% ...").
2. **Dominator tree** — objects ranked by *retained* size (what would be
   freed if this object died). The top of this tree is the answer to "what's
   holding the memory" in a way a histogram (shallow sizes) can't show.
3. **Path to GC roots** (right-click → exclude weak/soft references) — *why*
   is it still alive: the reference chain from a GC root to your suspect.
   This names the field, the map, the listener list that should have let go.

Dumps from `HeapDumpOnOutOfMemoryError` show the heap at its worst moment —
usually the most incriminating dump you'll ever get. Prefer analyzing those
over on-demand dumps when both exist.
