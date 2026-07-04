---
title: "Linux Inside the Pod: A Field Guide"
description: What to run and how to read it once you're exec'd into a container — memory, CPU, disk, and network truth from /proc and cgroup files, with and without tools.
sidebar:
  order: 14
---

You're in. `kubectl exec -it` worked, you have a shell, and something is wrong. This page is about the next twenty minutes: which files to read, which commands to run, and — critically — how to *interpret* the output, because inside a container half of what Linux tells you is about the node, not about you. If you *can't* get a shell or the image has no tools at all, that's the sibling problem: [The BusyBox Toolkit](/troubleshooting/busybox/) covers getting tools in. This page assumes you're inside and covers what to do there.

The organizing trick for tool-less images: almost every question below has two answers — the comfortable command, and the `/proc` file it reads under the hood. When the command is missing, the file is still there. [proc(5)](https://man7.org/linux/man-pages/man5/proc.5.html) is *the* reference for this whole page; keep it open.

## Where am I? (orientation in 60 seconds)

First: who are you, what is this thing?

```console
$ id
uid=1000(app) gid=1000(app) groups=1000(app)
$ hostname
payments-api-7d9c6b4f8-x2vlq
$ cat /etc/os-release
PRETTY_NAME="Alpine Linux v3.20"
ID=alpine
```

**How to read it:** uid 1000, not root — expected on any cluster enforcing [pod security](/workloads/pod-security/), and it explains upcoming `Permission denied` errors before they surprise you. The hostname is the pod name, which tells you you're in the right pod (check the ReplicaSet hash against what you meant to exec into). `os-release` tells you which package ecosystem and which shell dialect you're dealing with — Alpine means BusyBox `ash`, which matters later.

If `id` doesn't exist (minimal images), the kernel will tell you anyway:

```console
$ grep -E 'Uid|Gid' /proc/self/status
Uid:    1000    1000    1000    1000
Gid:    1000    1000    1000    1000
```

Next, the environment — where does this app *think* it's pointing?

```bash
env | sort | grep -Ei 'host|port|url|db'
```

No `env` binary? PID 1's environment is a file:

```console
$ tr '\0' '\n' < /proc/1/environ | sort | grep -i db
DB_HOST=postgres.data.svc.cluster.local
DB_POOL_SIZE=20
```

**How to read it:** `/proc/1/environ` is the environment PID 1 was *started* with — it does not reflect anything exported later in an entrypoint script. If a value looks wrong, the fix is in the manifest, not the shell; see [Environment Variables](/workloads/environment-variables/) for where each variable comes from.

Finally, the mount map — what storage is attached and where:

```console
$ grep -v cgroup /proc/mounts | grep -Ev 'proc|sysfs|devpts|mqueue|shm'
overlay / overlay rw,relatime,lowerdir=/var/lib/... 0 0
/dev/nvme1n1 /var/lib/app/data ext4 rw,relatime 0 0
tmpfs /tmp tmpfs rw,nosuid,nodev,size=524288k 0 0
tmpfs /run/secrets/kubernetes.io/serviceaccount tmpfs ro,relatime 0 0
```

**How to read it:** `/` on `overlay` is the container image (ephemeral). The `ext4` line is your PersistentVolume — note it's `rw`; if a volume shows `ro` when it shouldn't, or is missing entirely, jump to [Volume Failures](/troubleshooting/volume-failures/). The `tmpfs /tmp` line means writes to `/tmp` are RAM, counted against your memory limit — a common invisible memory consumer.

:::tip[The theme of this page]
Every command above has a `/proc` fallback, and that's true of nearly everything below. `mount` reads `/proc/mounts`. `env` reads what `/proc/1/environ` holds. On an image with only `cat`, `grep`, and `ls` you can still answer every diagnostic question on this page. The kernel's own tour of the filesystem is at [docs.kernel.org/filesystems/proc](https://docs.kernel.org/filesystems/proc.html).
:::

## What is running in here?

No `ps`? Every process is a directory:

```console
$ ls -d /proc/[0-9]*
/proc/1  /proc/1841  /proc/23
$ tr '\0' ' ' < /proc/1/cmdline; echo
java -Xmx512m -jar /app/app.jar
$ tr '\0' ' ' < /proc/23/cmdline; echo
/bin/sh
```

Three processes: the app (PID 1), your shell, and this `ls`. That's a normal container. Now the vital signs of the interesting one:

```console
$ grep -E 'State|Threads|VmRSS|FDSize' /proc/1/status
State:  S (sleeping)
Threads:        47
VmRSS:    612340 kB
FDSize: 256
```

**How to read it:** `State: S` is fine — a healthy server *sleeps* between requests. `D` (uninterruptible) is the red flag: stuck on I/O, usually a bad volume or NFS mount. `Z` is a zombie waiting to be reaped. `Threads: 47` — sane for a JVM; thousands means a thread leak. `VmRSS` is actual resident memory, your first memory datapoint (more below). `FDSize` is just the fd-table allocation size, not the open count — the real count comes in the disk section.

Count threads without `ps -L`:

```console
$ ls /proc/1/task | wc -l
47
```

**The PID 1 question.** Is your app PID 1? Usually yes, and it matters twice. First, signals: when Kubernetes stops the pod, SIGTERM goes to PID 1 — if that's a shell script wrapping your app, the app never hears it and gets SIGKILLed 30 seconds later. Second, some diagnostics target PID 1 directly, like `kill -3 1` for a JVM thread dump ([Thread Dumps, JRE Only](/java/thread-dumps-jre-only/)). The full signal semantics live in [signal(7)](https://man7.org/linux/man-pages/man7/signal.7.html).

When `ps` *does* exist, use it — but know which one you have:

```console
$ ps aux
PID   USER     TIME  COMMAND
    1 app      2h14  java -Xmx512m -jar /app/app.jar
   23 app      0:00  /bin/sh
```

:::caution[BusyBox ps is not procps ps]
Alpine/BusyBox `ps` ignores most flags (`aux` happens to be tolerated) and shows a stripped-down format with no %CPU or %MEM columns. procps `ps` (Debian/Ubuntu with `procps` installed) supports the full [ps(1)](https://man7.org/linux/man-pages/man1/ps.1.html) flag zoo, including the very useful `ps -eLf` (threads) and `ps -o pid,rss,vsz,stat,cmd`. If a flag "doesn't work", you're probably on BusyBox — fall back to `/proc` rather than fighting it. Same story for `top`.
:::

## How much memory do I actually have — and how much am I using?

Here is the single most important trap on this page:

:::danger[/proc/meminfo lies to you]
`free`, `top`, and `cat /proc/meminfo` inside a container all show the **node's** memory — 64 GB free on the host means nothing when your container has a 512 MiB limit. Any tool that reads `/proc/meminfo` is reporting the wrong machine. The truth lives in the cgroup files below.
:::

The real numbers, on any modern cluster (cgroup v2):

```console
$ cat /sys/fs/cgroup/memory.max
536870912
$ cat /sys/fs/cgroup/memory.current
498073600
```

**How to read it:** limit 512 MiB, usage 475 MiB — you are 93% of the way to an OOM kill. `memory.max` of `max` (the literal string) means no limit was set; see [Resources and QoS](/workloads/resources-and-qos/) for what that implies. The full file reference is the kernel's [cgroup v2 guide](https://docs.kernel.org/admin-guide/cgroup-v2.html).

But `memory.current` includes reclaimable page cache, so break it down:

```console
$ grep -E '^(anon|file|inactive_file|slab|sock) ' /sys/fs/cgroup/memory.stat
anon 412876800
file 71303168
inactive_file 58720256
slab 9437184
sock 1048576
```

**How to read it:** `anon` is heap/stack — memory that *cannot* be reclaimed; this is your app's true footprint. `file` is page cache from reading/writing files; most of it (`inactive_file`) can be dropped under pressure. The working set — what the OOM killer effectively judges you on — is approximately `memory.current − inactive_file`: here 475 − 56 = ~419 MiB. If `anon` alone is near `memory.max`, you are going to be OOM killed and no amount of cache reclaim will save you.

Has it already happened?

```console
$ grep oom_kill /sys/fs/cgroup/memory.events
oom_kill 3
```

That counter is ground truth: the kernel has OOM-killed processes in this cgroup three times since the container started. If it's nonzero, stop guessing and go to [OOMKilled](/troubleshooting/oomkilled/).

Per-process, back in `/proc/<pid>/status`: **VmRSS vs VmSize**. `VmSize` is address space *reserved* (a JVM or Go runtime maps gigabytes it never touches — ignore it). `VmRSS` is pages actually resident — this is what counts against the limit. For the detailed budget of one process:

```console
$ grep -E 'Rss|Anonymous|Shared' /proc/1/smaps_rollup
Rss:              612340 kB
Shared_Clean:      41208 kB
Anonymous:        563112 kB
```

`smaps_rollup` splits RSS into anonymous (heap, arenas, thread stacks) versus shared file-backed (libraries, mapped JARs — cheap, shared with other users of the same pages). A JVM whose `Anonymous` far exceeds `-Xmx` has native/off-heap growth — the full hunt is in [Memory Leaks and OOM](/java/memory-leaks-and-oom/).

:::note[cgroup v1 fallback]
On older clusters `/sys/fs/cgroup/memory.max` won't exist. The v1 equivalents: `/sys/fs/cgroup/memory/memory.limit_in_bytes` (limit), `memory.usage_in_bytes` (usage), `memory.stat` (breakdown — fields named `total_rss`, `total_cache`), and `memory.oom_control` / `memory.failcnt` for OOM evidence. Quick test for which world you're in: `cat /sys/fs/cgroup/cgroup.controllers` exists only on v2.
:::

## How much CPU do I actually have?

Same trap, second verse: `/proc/cpuinfo` and `nproc` show the **node's** cores. Seeing 32 processors means nothing with a 500m limit. The truth:

```console
$ cat /sys/fs/cgroup/cpu.max
50000 100000
```

**How to read it:** "quota period" in microseconds — 50,000 µs of CPU time per 100,000 µs window = **half a core**. `max 100000` means unthrottled. `200000 100000` = two cores. Whether that limit should exist at all is a tuning debate — see [Requests, Limits, and the Knobs](/tuning/requests-limits-knobs/).

And whether that limit is *hurting* you, readable right here without any monitoring stack:

```console
$ cat /sys/fs/cgroup/cpu.stat
usage_usec 1843200000
user_usec 1621000000
system_usec 222200000
nr_periods 184032
nr_throttled 9217
throttled_usec 460850000
```

**How to read it:** `nr_throttled 9217` out of 184,032 periods — this container hit its quota and was frozen in **5% of all scheduling periods**, for a cumulative 460 seconds. That is the smoking gun for "latency spikes but CPU graphs look fine": averaged metrics hide throttling, this counter doesn't. Read it twice, 30 seconds apart; if `nr_throttled` is climbing *now*, your current incident is CPU starvation.

Two supporting reads. `/proc/loadavg` is node-wide, so its absolute value is nearly meaningless in a container — but the fourth field (`3/412` = runnable/total *visible* to your PID namespace) is yours. And per-process CPU without `top`:

```console
$ awk '{print "utime="$14" stime="$15}' /proc/1/stat
utime=162100 stime=22220
```

Those are in clock ticks (jiffies), almost always 100/second (`getconf CLK_TCK` confirms) — so 162,100 ticks = 1,621 s of user CPU. Sample twice and subtract: (Δutime + Δstime) / CLK_TCK / Δseconds = cores consumed by that process.

## Who is eating the disk?

```console
$ df -h
Filesystem      Size  Used Avail Use% Mounted on
overlay          80G   62G   18G  78% /
/dev/nvme1n1    9.8G  9.7G     0 100% /var/lib/app/data
tmpfs           512M  380M  132M  75% /tmp
```

**How to read it:** three different budgets. `overlay /` is the *node's* image filesystem — 78% is the node's problem (though writing to it counts against your ephemeral-storage limit). Your PV at 100% is the incident. And `/tmp` on tmpfs is memory dressed as disk. Find the eater:

```bash
du -xsh /var/lib/app/data/* 2>/dev/null | sort -h | tail -5
```

The `-x` flag matters: it stops `du` from crossing filesystem boundaries, so measuring `/` doesn't descend into your 9.8 GB volume and secrets tmpfs and produce garbage. No `du`? Descend by sorted size manually — `ls -lS <dir>` (largest first), recurse into the fattest directory, repeat; three levels usually finds it.

**The classic: `df` says full, `du` finds nothing.** A process is holding a deleted file open — the space isn't freed until the last fd closes:

```console
$ ls -l /proc/1/fd | grep deleted
l-wx------ 1 app app 64 Jul  3 02:11 4 -> /var/lib/app/data/app.log.1 (deleted)
```

A log was rotated by deletion while the app kept the handle. The fix is bouncing the process (or the pod), not more deleting. Full storage triage: [Volume Failures](/troubleshooting/volume-failures/).

**"Too many open files"** is the other fd incident. Compare count against ceiling:

```console
$ ls /proc/1/fd | wc -l
4052
$ grep 'open files' /proc/1/limits
Max open files       4096      4096      files
```

44 fds from the ceiling — the next accept() or open() fails. Are they sockets (connection leak) or files? `ls -l /proc/1/fd | awk -F' -> ' '{print $2}' | sort | uniq -c | sort -rn | head` groups them. The soft/hard limit semantics are [getrlimit(2)](https://man7.org/linux/man-pages/man2/getrlimit.2.html); raising them is a securityContext/runtime setting, not something you can fix in-pod.

Basic identity of a suspicious file: `stat file` (size, mtime, owner — *is this config as new as I think it is?*) and `file file` when present (is this "text" actually a binary or an empty file?).

## Is the network actually working?

With `ss` present (Debian-family images, netshoot):

```console
$ ss -tnp
State  Recv-Q Send-Q Local Address:Port  Peer Address:Port  Process
ESTAB  0      0       10.244.1.23:38412   10.96.14.5:5432   users:(("java",pid=1,fd=112))
ESTAB  42131  0       10.244.1.23:8080    10.244.3.9:51230  users:(("java",pid=1,fd=87))
LISTEN 0      128     0.0.0.0:8080        0.0.0.0:*         users:(("java",pid=1,fd=45))
```

**How to read it:** `Recv-Q 42131` on an ESTAB socket means 42 KB has arrived that *your app has not read* — the app is stalled, not the network. A growing `Send-Q` is the mirror image: the peer isn't draining. Count connections per peer with `ss -tn | awk '{print $5}' | sort | uniq -c | sort -rn | head` — hundreds of ESTAB to one Service IP suggests a pool leak or a conntrack story, which continues in [kube-proxy and the Dataplane](/routing/kube-proxy-and-the-dataplane/). Flag reference: [ss(8)](https://man7.org/linux/man-pages/man8/ss.8.html).

**No `ss`, no `netstat`?** The kernel's socket table is `/proc/net/tcp`, in hex. One real line, decoded:

```console
$ cat /proc/net/tcp
  sl  local_address rem_address   st tx_queue rx_queue ...
   2: 1701F40A:1F90 050E600A:1538 01 00000000:00000000 ...
```

Walk it: `1701F40A` is the local IP as four hex bytes, **little-endian** — read the bytes right-to-left: `0A`=10, `F4`=244, `01`=1, `17`=23 → `10.244.1.23`. Port `1F90` is *normal* hex → 8080. Remote `050E600A:1538` → `0A.60.0E.05` = 10.96.14.5, port 0x1538 = 5432. State `01` = ESTABLISHED. The states you'll actually meet: `01` ESTABLISHED, `02` SYN_SENT (connecting — stuck here means nothing is answering), `06` TIME_WAIT, `0A` LISTEN, `08` CLOSE_WAIT (peer hung up, your app hasn't closed — piles of these are an app bug). `/proc/net/udp` is the same format — a row with remote port `0035` (53) confirms a DNS query is in flight.

DNS config is always readable:

```console
$ cat /etc/resolv.conf
search payments.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

If lookups fail or crawl, that `ndots:5` line and the nameserver IP are your leads — the whole story is in [DNS](/networking/dns/).

Connectivity probe without curl or nc — bash only:

```bash
timeout 2 bash -c 'echo > /dev/tcp/postgres.data.svc.cluster.local/5432' \
  && echo open || echo closed-or-filtered
```

:::caution[/dev/tcp is a bash feature, not a file]
That path is synthesized by **bash** itself. BusyBox `ash` and `dash` don't implement it — on Alpine the command fails with `sh: can't create /dev/tcp/...: nonexistent directory`, which looks like a network failure but is just the wrong shell. No bash, no curl, no wget? You genuinely cannot make a TCP probe; copy in a tool ([BusyBox](/troubleshooting/busybox/)) or use a debug container ([Debugging Toolbox](/troubleshooting/debugging-toolbox/)). When `wget` exists (BusyBox has it): `wget -qO- --timeout=2 http://host:port/healthz`.
:::

## Poking processes: signals that diagnose, signals that kill

`kill` isn't only for killing:

```bash
kill -0 1841 && echo alive || echo gone     # -0 sends nothing; just checks existence
kill -3 1                                    # SIGQUIT: JVM prints a full thread dump to stdout
kill -TERM 1841                              # polite: handler runs, cleanup happens
kill -KILL 1841                              # kernel removes it; no cleanup, no flush
```

`kill -3` against a JVM is the highest-value move here: a complete thread dump lands in the container's stdout (i.e., `kubectl logs`) with the process still running — the full technique is [Thread Dumps, JRE Only](/java/thread-dumps-jre-only/). Prefer TERM over KILL always; KILL skips shutdown hooks, buffer flushes, and lock releases, per [signal(7)](https://man7.org/linux/man-pages/man7/signal.7.html).

**The PID 1 surprise:** `kill -9 1` inside the container often does *nothing*. The kernel refuses to deliver a signal to a PID-namespace init unless that process installed a handler for it — and SIGKILL/SIGSTOP can't be handled, so from inside the namespace they're simply discarded. This is why "I killed the app but it's still running" happens, and why the right way to restart PID 1 is `kubectl delete pod` and letting the runtime (which signals from *outside* the namespace) do it.

## What sandbox am I in?

The full limits table:

```console
$ cat /proc/1/limits
Limit                     Soft Limit  Hard Limit  Units
Max open files            4096        4096        files
Max processes             15243       15243       processes
Max locked memory         8388608     8388608     bytes
Max core file size        0           0           bytes
...
```

**How to read it:** open files you've met; `Max processes` bounds threads too (thread creation failures with memory to spare point here); `Max core file size 0` means a crash writes no core dump — worth knowing before you wait for one. Which cgroup owns you:

```console
$ cat /proc/self/cgroup
0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod7f3a....slice/cri-containerd-9c2e....scope
```

The single `0::` line confirms cgroup v2, and `burstable` in the path is your QoS class read straight from the kernel. Capabilities without `capsh`:

```console
$ grep Cap /proc/self/status
CapPrm: 0000000000000000
CapEff: 0000000000000000
CapBnd: 00000000a80425fb
```

`CapEff` is a 64-bit mask, one bit per capability — all zeros means you hold none (restricted profile, the good default; see [Pod Security](/workloads/pod-security/)). `a80425fb` is the classic default-container set (chown, net_bind_service, kill, ...); decode any value with `capsh --decode=<hex>` on a machine that has it. And the read-only-root check:

```console
$ touch /probe
touch: /probe: Read-only file system
```

`readOnlyRootFilesystem: true` — writes must go to a mounted volume or `emptyDir`, which reframes any "app can't write its temp file" error instantly.

## The 2am snapshot: one paste for the incident channel

Everything above, compressed into one block that works on BusyBox `ash` with no tools beyond `cat`, `grep`, `ls`, and `df`:

```bash
echo "=== WHO/WHERE ==="; hostname; grep Uid /proc/self/status; grep PRETTY /etc/os-release
echo "=== PID1 ==="; tr '\0' ' ' < /proc/1/cmdline; echo
grep -E 'State|Threads|VmRSS' /proc/1/status
echo "=== MEMORY (cgroup) ==="
cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current 2>/dev/null
grep -E '^(anon|inactive_file) ' /sys/fs/cgroup/memory.stat 2>/dev/null
grep oom_kill /sys/fs/cgroup/memory.events 2>/dev/null
echo "=== CPU (cgroup) ==="
cat /sys/fs/cgroup/cpu.max 2>/dev/null
grep -E 'nr_throttled|throttled_usec' /sys/fs/cgroup/cpu.stat 2>/dev/null
echo "=== DISK ==="; df -h 2>/dev/null | grep -v overlay
echo "=== FDS ==="; ls /proc/1/fd | wc -l; grep 'open files' /proc/1/limits
echo "=== NET ==="; grep -c '01 ' /proc/net/tcp; cat /etc/resolv.conf | head -2
```

Paste the output into the incident channel *before* you start changing things — it's the "capture state first" step of the [triage methodology](/troubleshooting/triage-methodology/), and it pairs with the pod's recent logs ([Logging Fundamentals](/observability/logging-fundamentals/)) as the minimum evidence bundle for whoever wakes up next.

## What works where

| Technique | distroless | busybox/alpine | debian-slim | debian + procps/iproute2 |
|---|---|---|---|---|
| shell to run any of this | — | ash | bash | bash |
| `/proc` + `/sys/fs/cgroup` reads (cat/grep) | —* | yes | yes | yes |
| `ps`, `top` | — | BusyBox variants | usually **absent** | full procps |
| `ss` | — | — | — | yes |
| `/proc/net/tcp` decoding | —* | yes | yes | yes (but use `ss`) |
| `/dev/tcp` probe | — | — (ash) | yes (bash) | yes |
| `du -x` / `df -h` | — | yes | yes | yes |
| `kill -0` / `kill -3` | — | yes | yes | yes |

\* The files are there; there's no shell or `cat` to read them with. That leftmost column is exactly what [The BusyBox Toolkit](/troubleshooting/busybox/) exists to fix: one ephemeral container or one copied binary, and every row on this page lights up.

The pattern to internalize: commands are conveniences, `/proc` and `/sys/fs/cgroup` are the truth, and the container-vs-node distinction — meminfo lies, cpuinfo lies, cgroup files don't — is the difference between reading the right machine and the wrong one at 2am.
