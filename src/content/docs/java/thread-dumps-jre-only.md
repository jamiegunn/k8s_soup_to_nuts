---
title: Thread Dumps with a JRE Only
description: Every way to get a JVM thread dump from a Kubernetes pod without a JDK — SIGQUIT, jattach, ephemeral containers — and how to actually read one.
sidebar:
  order: 3
---

A thread dump answers "what is every thread doing *right now*": deadlocks,
stuck connection pools, hot loops, threads piled up on one lock. It's the
cheapest, safest piece of JVM evidence there is — capturing one pauses the
JVM for milliseconds — and you can always get one, no JDK required.

## Option 1: SIGQUIT — always works, learn this first

Every HotSpot JVM dumps all thread stacks to **its own stdout** when it
receives `SIGQUIT` (signal 3). The JVM does not exit — despite the signal's
name, HotSpot handles it as "print thread dump and carry on". Since container
stdout is what `kubectl logs` shows, the full loop is:

```bash
# Send SIGQUIT to the JVM (here it's pid 1 in the container)
kubectl exec myapp-7d4b9c6f5d-x2klm -- kill -3 1

# The dump went to the JVM's stdout, i.e. the container log:
kubectl logs myapp-7d4b9c6f5d-x2klm --since=1m
```

```console
Full thread dump OpenJDK 64-Bit Server VM (21.0.5+11-LTS mixed mode, sharing):

"http-nio-8080-exec-4" #52 [78] daemon prio=5 os_prio=0 cpu=182734.55ms elapsed=86382.11s tid=0x00007f3a4c1b2800 nid=78 waiting on condition  [0x00007f3a1c5fe000]
   java.lang.Thread.State: WAITING (parking)
	at jdk.internal.misc.Unsafe.park(java.base@21.0.5/Native Method)
	- parking to wait for  <0x00000000e1a4f2c8> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
	at org.apache.tomcat.util.threads.TaskQueue.take(TaskQueue.java:141)
	...
```

Notes that save you time:

- `kill` here is usually the shell builtin or busybox applet; even minimal
  images tend to have it. If there is truly no `kill` and no shell
  (distroless), jump to Option 4.
- The dump interleaves with normal application log lines. Grab a window with
  `--since=` or `--tail=` and search for `Full thread dump`.
- If your log pipeline chokes on 2,000 sudden lines, that's a feature request
  for the pipeline, not a reason to avoid SIGQUIT.
- **This is why you should not use SIGQUIT-based "graceful shutdown" hacks**
  — and conversely, why `kill -3` is harmless: nothing stops.

### When the JVM isn't pid 1

If your entrypoint is a shell script or an init wrapper (tini, dumb-init),
pid 1 is not the JVM and signaling it does nothing useful. Find the real pid:

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- sh -c \
  'for p in /proc/[0-9]*; do
     tr "\0" " " < $p/cmdline | grep -q "^java " && echo "${p#/proc/}: $(tr "\0" " " < $p/cmdline)";
   done'
```

```console
7: java -jar /app/app.jar
```

Or simply `kubectl exec <pod> -- ps -ef | grep java` if `ps` exists. Then
`kill -3 7`. Reading `/proc` directly works even in images with no `ps`.

## Option 2: jcmd — if the jdk.jcmd module shipped

Check once per image: `java --list-modules | grep jdk.jcmd`. If present
(common in hand-rolled jlink images where someone had the foresight):

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- jcmd 7 Thread.print > dump-$(date +%s).txt
```

Advantages over SIGQUIT: output comes back on *your* terminal instead of the
pod log, and `Thread.print -l` adds ownable-synchronizer detail. Same
underlying data. `jcmd <pid> help` lists everything else you just gained
(heap dumps, JFR, VM.flags...).

## Option 3: jattach — bring the attach protocol in a 50 KB binary

[jattach](https://github.com/jattach/jattach) reimplements the JVM's dynamic
attach client as a small static binary with zero dependencies. It gives you
`threaddump`, `dumpheap`, and full `jcmd` passthrough on a bare JRE.

```bash
# Copy it in (kubectl cp needs tar in the image; if absent, see Getting dumps out)
kubectl cp ./jattach myapp-7d4b9c6f5d-x2klm:/tmp/jattach
kubectl exec myapp-7d4b9c6f5d-x2klm -- chmod +x /tmp/jattach
kubectl exec myapp-7d4b9c6f5d-x2klm -- /tmp/jattach 7 threaddump
```

The thread dump prints on your terminal. Better: bake `jattach` into the
image at build time (`COPY --from=...` a known checksum from your artifact
repo) so it's already there during an incident.

:::caution[Attach mechanics]
Dynamic attach requires the attacher to run as the **same UID** as the JVM
(exec'ing into the container gets you this for free, since you land as the
container's user) and the JVM must not have `-XX:+DisableAttachMechanism`
set. The handshake works by touching `/tmp/.attach_pid<pid>`, nudging the
JVM, and connecting to the UNIX socket `/tmp/.java_pid<pid>` — so a
read-only or unusual `/tmp` can break it.
:::

## Option 4: ephemeral debug container with a real JDK

When the image is distroless — no shell, no kill, no tar — bring the tools in
an ephemeral container that shares the pod's process namespace:

```bash
kubectl debug -it myapp-7d4b9c6f5d-x2klm \
  --image=eclipse-temurin:21-jdk \
  --target=myapp -- bash
```

`--target=myapp` puts the debug container in the *target container's* pid
namespace, so the JVM is visible:

```console
root@myapp-7d4b9c6f5d-x2klm:/# ps -ef | grep java
app          7     1  4 Jun12 ?        01:22:41 java -jar /app/app.jar
root@myapp-7d4b9c6f5d-x2klm:/# jstack 7
7: Unable to open socket file /proc/7/root/tmp/.java_pid7: target process doesn't respond...
```

That error is the classic caveat: **dynamic attach fails across UIDs.** The
debug image runs as root; the app runs as UID 1000 (`app`). Fixes, in order
of preference:

1. Run the debug container as the app's UID. With kubectl ≥ 1.31 you can use
   a custom debug profile; otherwise patch the ephemeral container spec, or
   simplest of all: `su app -s /bin/bash` inside the debug container if the
   image has the user, or `setpriv --reuid=1000 --regid=1000 --clear-groups jstack 7`.
2. Use SIGQUIT from the debug container instead — signals only need
   root-or-same-user, and root qualifies: `kill -3 7`, then read
   `kubectl logs myapp-... -c myapp`.

Other cross-namespace details worth knowing:

- Modern JDK tools (10+) automatically try the target-relative path
  `/proc/<pid>/root/tmp/.java_pid<pid>`, so the separate *mount* namespace is
  handled; UID mismatch is the usual remaining blocker.
- `jps` may show nothing even when attach works: it reads
  `/tmp/hsperfdata_<user>/<pid>` from *its own* `/tmp`. Don't trust an empty
  `jps`; use `ps` and attach by pid.
- Ephemeral containers can't be removed until the pod restarts, and their
  presence is visible in `kubectl describe pod`. Fine — just don't leave
  interactive sessions running.

If `kubectl debug` is denied, that's an RBAC gate (`pods/ephemeralcontainers`)
— ask your platform team; see
[Working with the platform team](/operations/working-with-platform-team/).

## Option 5: Spring Boot Actuator

If the app exposes Actuator, `/actuator/threaddump` returns the same data as
JSON (or plain text with `Accept: text/plain`):

```bash
kubectl port-forward myapp-7d4b9c6f5d-x2klm 8081:8081
curl -H 'Accept: text/plain' localhost:8081/actuator/threaddump > dump.txt
```

Zero exec required — useful when even `kubectl exec` is restricted. It only
covers threads the JVM can enumerate normally, which in practice is all you
need.

## Capture 3–5 dumps, 10 seconds apart

One dump is a photograph; you need a flip-book. A thread "RUNNABLE in
`SocketRead`" once is normal; the *same thread in the same frame* across five
dumps spanning a minute is a hang.

```bash
POD=myapp-7d4b9c6f5d-x2klm
for i in 1 2 3 4 5; do
  kubectl exec $POD -- kill -3 7
  sleep 10
done
kubectl logs $POD --since=2m > dumps-$(date +%Y%m%d-%H%M).log
```

## Reading a thread dump

Each entry: thread name, priority, `cpu=` (total CPU consumed — gold for hot
loops), `nid` (native thread id), state, and the stack.

| State | Meaning | Usual interpretation |
|---|---|---|
| `RUNNABLE` | Running or ready — includes threads blocked in native I/O! | `SocketRead`/`epollWait` in frame = waiting on network, not burning CPU |
| `BLOCKED` | Waiting to *enter* a `synchronized` block | Look for `waiting to lock <0x...>` and find who `locked <0x...>` |
| `WAITING` | `Object.wait()`, `park()`, `join()` — indefinite | Idle pool threads look like this; normal in bulk |
| `TIMED_WAITING` | Same, with timeout | `sleep()`, poll loops — usually normal |

**Deadlocks:** the JVM detects monitor deadlocks for you — search the bottom
of the dump for `Found one Java-level deadlock:`. It names the threads and
the lock cycle. (It cannot detect deadlocks built purely from
`java.util.concurrent` locks unless you use `jcmd Thread.print -l` /
Actuator, which report ownable synchronizers.)

**Lock convoys:** many threads `BLOCKED` ... `waiting to lock <0x00000000e1b0aa10>`,
and exactly one thread holds it (`- locked <0x00000000e1b0aa10>`). Read the
holder's stack — that's your bottleneck. Classic finds: a `synchronized`
logger appender, a legacy `Hashtable`, `ConnectionPool.getConnection`.

**Hot loops:** compare `cpu=` between two dumps taken 10 s apart. A thread
that gained ~10,000 ms of CPU in 10 s of wall time is spinning a full core.
Its stack frame tells you where.

**Pool exhaustion:** all 200 `http-nio-8080-exec-*` threads WAITING inside
`dataSource.getConnection` = your DB pool is smaller than your HTTP pool, or
something is leaking connections. The dump shows the shape instantly.

:::tip
Paste multi-dump captures into a analyzer like fastThread or IntelliJ's
thread-dump viewer for grouping — but learn to skim raw dumps first. During
a real incident, grouping-by-identical-stack with
`grep -A2 'java.lang.Thread.State' dump.txt | sort | uniq -c | sort -rn`
gets you 80% of the answer in ten seconds.
:::

Next: the heavier sibling — [heap dumps on a JRE](/java/heap-dumps-jre-only/) —
and [getting large files out of the pod](/java/getting-dumps-out/).
