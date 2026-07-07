---
title: "jattach Deep Dive"
description: The 30 KB static binary that speaks HotSpot dynamic attach with no JDK — live thread dumps, heap dumps, and jcmd from a pod or a bare-metal host.
keywords:
  - Unable to open socket file target process not responding
  - HotSpot dynamic attach protocol
  - .java_pid socket attach listener
  - jstack not found distroless
  - DisableAttachMechanism
  - systemd PrivateTmp java attach
  - proc pid root tmp namespace
  - kubectl debug shareProcessNamespace
  - async-profiler attach agent
  - UID mismatch attach non-root
  - inspectheap class histogram
  - SIGQUIT attach marker file
sidebar:
  order: 4
---

There is one tool that turns "this JRE has no `jstack`, no `jmap`, no `jcmd`"
from a wall into a shrug: **jattach**. It's a ~30 KB self-contained static
binary (Andrei Pangin's [jattach](https://github.com/jattach/jattach), also
bundled inside async-profiler) that implements the HotSpot **Dynamic
Attach** protocol directly. No JDK, no shared libraries, no runtime — you drop
one file next to a live JVM and pull thread dumps, heap dumps, class
histograms, run any `jcmd`, read flags, or load an agent.

The other JRE-only articles reach for jattach as one option among several.
This one is the deep dive: how attach *actually* works, why it fails, and how
to make it work in the two places you'll need it — inside a Kubernetes pod and
on a bare-metal host. The failure modes are identical in both worlds because
they come from the protocol itself.

## How dynamic attach works (all the gotchas live here)

Understand these three steps once and every error message later explains
itself:

1. The attacher creates a **marker file** — `/proc/<pid>/cwd/.attach_pid<pid>`
   (or in `/tmp`) — then sends **SIGQUIT** (signal 3) to the JVM.
2. The JVM's **AttachListener** thread wakes on that signal, sees the marker,
   and opens a **Unix domain socket** at `<java.io.tmpdir>/.java_pid<pid>` —
   usually `/tmp/.java_pid<pid>`.
3. The attacher connects to that socket, sends the command, and the JVM
   streams the output back.

Three consequences fall straight out of this, and they are the whole story:
the attacher must be able to (a) **signal** the target process, (b) **reach
the JVM's tmp directory** to find the socket, and (c) **match the target's
credentials**. Break any one and you get an error, not a dump.

```text
attacher                          JVM (AttachListener)
   |  touch .attach_pid<pid>            |
   |  kill -QUIT <pid>  ───────────────►|  wakes, creates
   |                                    |  /tmp/.java_pid<pid>
   |  connect(/tmp/.java_pid<pid>) ◄────|
   |  "threaddump\0" ──────────────────►|
   |  ◄──────────────── output stream ──|
```

## The command set

Syntax is always `jattach <pid> <cmd> [args...]`:

| Command | What you get | JDK equivalent |
|---|---|---|
| `threaddump` | Full thread dump | `jstack` / `kill -3` |
| `dumpheap <filepath>` | HPROF heap dump | `jmap -dump` |
| `inspectheap` | Class histogram | `jmap -histo` / `GC.class_histogram` |
| `jcmd <command...>` | Any Diagnostic Command | `jcmd` |
| `load <path> {true\|false} <opts>` | Load a JVMTI/native agent | (how async-profiler attaches) |
| `properties` / `agentProperties` | System / agent properties | `jinfo` |
| `printflag <Flag>` / `datadump` | One flag value / data dump | `jinfo -flag` |

The `jcmd` passthrough is the escape hatch that makes jattach a full toolkit:

```bash
jattach 1 jcmd GC.heap_info
jattach 1 jcmd VM.flags
jattach 1 jcmd Thread.print
jattach 1 jcmd "VM.native_memory summary"   # needs -XX:NativeMemoryTracking
```

:::caution[dumpheap writes on the JVM's side of the fence]
`dumpheap <filepath>` is executed **by the JVM**, so the path is resolved
inside the JVM's own filesystem and mount namespace — not the attacher's.
Point it at a path the JVM can write (an `emptyDir`/PVC mount like `/dumps`),
then extract the file separately. Do not assume the file appears where you ran
jattach.
:::

## The gotchas — where people lose hours

- **UID/GID must match.** The attacher must run as the JVM's effective UID
  (or as root). Mismatch gives the canonical error:
  `Unable to open socket file /tmp/.java_pid<pid>: target process not
  responding or HotSpot VM not loaded`. Run as root and jattach **drops to
  the target's uid/gid automatically** before connecting.
- **PID namespaces.** In a container the JVM is usually PID 1 *in its own
  namespace*. To attach you must either be **in the same PID namespace**
  (share it) using the **namespaced PID** (often `1`), or attach **from the
  host** using the **host-side PID**. jattach detects a different namespace,
  enters the target's mount/PID namespace, and resolves the socket under
  `/proc/<pid>/root/tmp`.
- **tmp visibility.** The socket lives in the JVM's tmp. From the host that's
  `/proc/<pid>/root/tmp/.java_pid<pid>`. If the container has
  `readOnlyRootFilesystem: true` and no writable `/tmp`, the attach *marker*
  file can't be created and attach fails — mount an `emptyDir` at `/tmp`.
- **`-XX:+DisableAttachMechanism`** turns attach off entirely. Nothing works,
  no workaround — that's a rebuild / JVM-flag conversation with whoever owns
  the image.
- **systemd `PrivateTmp=true`** (very common on bare metal) gives the service
  a private `/tmp`, so `/tmp/.java_pid<pid>` is **not** in the global `/tmp`.
  Reach it via `/proc/<pid>/root/tmp` as root.
- **SELinux / AppArmor** on hardened hosts can block the socket connect or the
  ptrace-like namespace entry. That's a platform conversation, not a flag you
  flip.

## In-cluster: attaching inside Kubernetes

### Method A (preferred): an ephemeral container that shares the PID namespace

`kubectl debug --target` drops a container into your pod that **shares the
target container's process namespace**, so the JVM is visible. Use a tools
image that already ships jattach — one you build by `COPY`ing the static
binary into a small base (call it `registry.example.com/jvm-tools:latest`
here; there's no need for it to be public):

```bash
kubectl debug -it myapp-7d4b9c6f5d-x2klm \
  --image=registry.example.com/jvm-tools:latest \
  --target=app -- jattach 1 threaddump
```

With `--target` sharing, the debug container sees the JVM by its **namespaced
PID — often `1`**. That's why the example attaches to `1`, not to a host pid.

:::caution[Pod Security `restricted`: match the UID or you get nothing]
Under a `restricted` Pod Security Standard the JVM runs as a fixed non-root
user (say UID `10001`). Your ephemeral container **cannot run as root** there,
and attach needs a matching UID — so the debug container must run as the *same
UID*. There's no `runAsUser` flag on `kubectl debug` directly; set it with a
custom debug profile (kubectl ≥ 1.31) or patch the ephemeral container spec:

```bash
kubectl debug -it myapp-7d4b9c6f5d-x2klm --target=app \
  --image=registry.example.com/jvm-tools:latest \
  --custom=<(echo '{"securityContext":{"runAsUser":10001,"runAsGroup":10001}}') \
  -- jattach 1 threaddump
```

If the image also runs as `10001` you're done; if UIDs disagree you'll see the
`Unable to open socket file` error again. See
[Pod Security](/workloads/pod-security/) for why you can't just go root, and
the [Debugging Toolbox](/troubleshooting/debugging-toolbox/) for building a
tools image that carries jattach.
:::

### Method B: a permanent sidecar with shareProcessNamespace

If you want attach capability baked in — not bolted on during an incident —
set `shareProcessNamespace: true` on the pod so a sidecar can see and attach
to the app JVM:

```yaml
spec:
  shareProcessNamespace: true
  containers:
    - name: app
      image: myapp:1.4.2
    - name: tools           # your image carrying the jattach static binary
      image: registry.example.com/jvm-tools:latest
      command: ["sleep", "infinity"]
```

With a shared namespace the sidecar sees the JVM at a namespaced pid (find it
with `ps`; it may not be `1` once a second container is in the namespace). Same
UID-match rule applies — give the sidecar the app's `runAsUser`. See
[init and sidecar containers](/workloads/init-and-sidecar-containers/) for the
lifecycle details.

### Getting the heap dump off the pod

Because `dumpheap <path>` writes into the **JVM's** filesystem, prefer a path
on a mounted `emptyDir`/PVC (like `/dumps`), then pull it out. That extraction
— `kubectl cp`, raw exec streams, helper pods — is its own article:
[Getting Dumps Out](/java/getting-dumps-out/). Don't re-derive it here.

## Bare-metal / host: attaching without Kubernetes

Everything above about UIDs, namespaces, and tmp applies identically on a VM
or physical host — you just have real PIDs and `sudo` instead of `kubectl`.

**Find the PID without a JDK:**

```bash
pgrep -f 'java'
ps -C java -o pid,user,args
# jps only if a JDK happens to be installed
```

**Match identity** — run as the service user, or as root (jattach adopts the
target's uid):

```bash
sudo -u appsvc jattach 48213 threaddump     # become the JVM's user
sudo jattach 48213 threaddump               # root → jattach drops to target uid
```

**The systemd PrivateTmp trap.** If the unit has `PrivateTmp=true` (check with
`systemctl show <unit> -p PrivateTmp`), the socket is in the service's private
tmp, invisible from the global `/tmp`. Attach as root and let jattach resolve
it through the target's namespace at `/proc/<pid>/root/tmp` — running as root
is what makes crossing into that namespace possible.

**Multiple JVMs, multiple service users** on one host — attach to each as its
own user:

| Service | PID | User | Attach as |
|---|---|---|---|
| orders-api | 48213 | `orders` | `sudo -u orders jattach 48213 threaddump` |
| billing | 51902 | `billing` | `sudo -u billing jattach 51902 inspectheap` |
| legacy-batch | 40771 | `root` | `jattach 40771 jcmd VM.flags` |

**Containers on a bare-metal host (docker/podman).** Attach from the host
using the **host PID**, and let jattach cross namespaces for you:

```bash
PID=$(docker inspect --format '{{.State.Pid}}' orders-ctr)
sudo jattach "$PID" threaddump
```

**SELinux note:** on an enforcing host the namespace entry or socket connect
can be denied even as root. `ausearch -m avc -ts recent` will show it; loosening
that policy is a platform-team task.

## Getting jattach onto the box

- **Distro package** where available (some repos ship a `jattach` package).
- **Download the static release binary** from the GitHub releases and verify
  its checksum — it has no dependencies, so it just runs.
- **Extract it from async-profiler**, which bundles jattach.
- **For distroless containers, don't try to install anything** — bring it in
  via the `kubectl debug` tools image (Method A), or `COPY --from=...` a
  pinned, checksummed binary into your own image at build time so it's already
  present when the incident starts.

## Failure-mode table

| Error / symptom | Likely cause | Fix |
|---|---|---|
| `Unable to open socket file ...: target process not responding or HotSpot VM not loaded` | Attacher UID ≠ JVM UID | Run as the JVM's user, or as root (jattach drops to target uid) |
| Same error, right user, containerized JVM | Wrong PID or wrong namespace | Host: use host PID. Shared namespace: use the namespaced PID (often `1`) |
| Attach hangs or "not responding", attach never enabled | `-XX:+DisableAttachMechanism` | Rebuild/relaunch without the flag — no runtime workaround |
| Fails creating marker file | `readOnlyRootFilesystem`, no writable `/tmp` | Mount an `emptyDir` at `/tmp` |
| Socket "not found" on bare metal, right user | systemd `PrivateTmp=true` | Attach as root via `/proc/<pid>/root/tmp` (jattach handles it) |
| Denied even as root on a hardened host | SELinux / AppArmor policy | Check `ausearch -m avc`; escalate to platform team |

## When you can't (or shouldn't) use jattach — JDK-free alternatives

jattach is not the only way in, and sometimes it's the wrong way in — attach
is off, the UID won't match, the JVM already crashed, or you simply don't need
a live socket. Every option below works **without a JDK**, which rules out
`jcmd`, `jstack`, and `jmap` — those ship with the JDK and we're assuming a
bare JRE.

### 1. Thread dump via SIGQUIT — the universal, zero-tool fallback

Send `kill -3 <pid>` (a.k.a. `kill -QUIT`) and the JVM prints a **full thread
dump to its stdout** — not a file, its stdout. No tool to install, present in
every HotSpot build ever shipped.

```bash
# In-cluster distroless (app container has no shell/kill): signal from a
# shared-PID-namespace tools container, then read the container log.
kubectl debug -it myapp-7d4b9c6f5d-x2klm --image=busybox --target=app -- kill -3 1
kubectl logs myapp-7d4b9c6f5d-x2klm -c app   # the dump is in the log
```

```bash
# Bare metal: the dump lands wherever stdout goes.
kill -3 48213
journalctl -u orders-api      # or catalina.out, or the console log
```

Caveats: SIGQUIT is safe — the JVM handles it and does **not** die. But if
stdout is discarded (`> /dev/null`, detached with no logging) you get nothing,
and you still need permission to signal the process (same UID or root).

### 2. Heap dump on OOM — pre-configured, needs no live tool at all

Set this **now**, before the incident, and the JVM writes its own HPROF the
moment it OOMs — no attach, no jattach, no JDK:

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps/heap.hprof"
volumeMounts:
  - { name: dumps, mountPath: /dumps }
volumes:
  - { name: dumps, emptyDir: {} }
```

Mount `/dumps` from an `emptyDir` (or a PVC) so the file survives
`readOnlyRootFilesystem: true` and outlives the container restart that follows
an OOM. This is the **post-mortem-on-OOM** path; jattach can't help once the
process is gone. See [Heap Dumps on a JRE](/java/heap-dumps-jre-only/).

### 3. Spring Boot Actuator over HTTP — no JVM tooling at all

If the app runs Actuator you need no attach, no exec, no matching UID, and no
shared PID namespace — it's pure HTTP, so it works even in distroless:

```bash
kubectl port-forward pod/myapp-7d4b9c6f5d-x2klm 8080:8080
curl -s  localhost:8080/actuator/threaddump   # JSON thread dump
curl -sOJ localhost:8080/actuator/heapdump     # downloads an HPROF file
```

Caveat: `/actuator/heapdump` is a full memory dump — a data-leak risk — so keep
it on a protected management port, not your public one. See
[Actuator](/java/actuator/).

### 4. JMX from a remote client — briefly

If `-Dcom.sun.management.jmxremote...` is enabled, a JMX client on **your
laptop** (VisualVM, JMC, or a small JMX CLI) can invoke
`HotSpotDiagnostic.dumpHeap` and `Thread.print` with no JDK on the pod/host —
`kubectl port-forward` the JMX port and connect. More setup than the others
(port, auth, RMI hostname), so reach for it only when it's already configured.

### 5. Always-on JFR — capture that already happened

`-XX:StartFlightRecording=...` set at launch records continuously with no
attach; you retrieve the `.jfr` afterward. This is the answer to "the
interesting thing happened before I got there."

### Which one?

| You have / want | Reach for |
|---|---|
| Any live JVM, just need a thread dump | `kill -3` (SIGQUIT) — universal |
| A Spring app | Actuator: **both** dumps over HTTP |
| To capture a heap on OOM | `-XX:+HeapDumpOnOutOfMemoryError` (set ahead) |
| Continuous history | Always-on JFR |
| **On-demand HEAP dump of a LIVE, non-crashing JVM with neither Actuator nor JMX** | **jattach** |

That last row is jattach's unique niche: a living JVM you need to dump *right
now*, with no HTTP surface and no JMX to lean on. That's when nothing else
works — and exactly why the note below draws the same line.

:::note[When NOT to reach for jattach]
jattach is a **live-capture** tool: a JVM that is hung, spinning, or
leaking-but-still-alive, where you need evidence *right now*. It cannot help a
process that already crashed — there's nothing to attach to. For
**OutOfMemoryError specifically**, don't plan to race in with jattach; set
`-XX:+HeapDumpOnOutOfMemoryError` ahead of time so the JVM dumps itself at the
exact worst moment. See [Heap Dumps on a JRE](/java/heap-dumps-jre-only/).
Use jattach for the living; use on-OOM dumps for the dead.
:::
