---
title: "Field Notes: The Heap Dump With No JDK"
description: A production memory leak, a jlink-minimized image with no jmap, and the four escalating techniques it took to get a 4GB hprof out of the pod.
date: 2026-02-10
authors: editor
tags:
  - java
  - jvm
  - memory
  - debugging
excerpt: We had a leaking Java service, a heap dump flag that silently wrote to a read-only filesystem, and an image so minimal it didn't have jmap, jcmd, or even tar. This is the story of getting the dump out anyway — and what we baked into every image afterward.
---

The page came in at 14:40 on a Tuesday: `orders-api` heap usage climbing about 3% an hour, restarts every 26 hours like clockwork. Classic slow leak. Not an emergency — the emergency was scheduled for whenever we stopped being able to prove what was leaking.

"Easy," I said. "Exec in, `jmap`, done by five."

```console
$ kubectl exec -it orders-api-7d9f6c5b48-x2klm -- jmap
error: exec: "jmap": executable file not found in $PATH
$ kubectl exec -it orders-api-7d9f6c5b48-x2klm -- jcmd
error: exec: "jcmd": executable file not found in $PATH
$ kubectl exec -it orders-api-7d9f6c5b48-x2klm -- jps
error: exec: "jps": executable file not found in $PATH
```

Some months earlier, another team had done us the favor of shrinking our base image with `jlink`. 480MB down to 110MB, faster pulls, smaller CVE surface — genuinely good work. It also stripped every diagnostic tool from the runtime. We had a JRE that could run our leak beautifully and tell us nothing about it.

## Attempt 1: The flag that was already there

First hope: we didn't need tools at all, because the deployment already had the right JVM flags. Someone had been diligent:

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:+HeapDumpOnOutOfMemoryError
      -XX:HeapDumpPath=/opt/app/dumps
```

The pod had OOMed twice in the last week. So where were the dumps?

```console
$ kubectl exec orders-api-7d9f6c5b48-x2klm -- ls /opt/app/dumps
ls: cannot access '/opt/app/dumps': No such file or directory
```

The directory didn't exist, and it couldn't be created, because our pod security settings — correctly — set `readOnlyRootFilesystem: true`. The JVM handles this failure by printing one line to stderr at OOM time and moving on:

```text
java.lang.OutOfMemoryError: Java heap space
Dumping heap to /opt/app/dumps/java_pid1.hprof ...
Unable to create /opt/app/dumps/java_pid1.hprof: No such file or directory
```

That line had been sitting in our logs, twice, for a week. Nobody greps for the failure mode of a safety net. The fix was one `emptyDir` volume mounted at the dump path — but a volume change means a rollout, a rollout means a fresh heap, and a fresh heap means waiting 20+ hours for the leak to reaccumulate. We wanted a dump from *this* process, at 80% heap, now.

## Attempt 2: Smuggling in jattach

You can trigger a heap dump without any JDK tools if you can speak the JVM's attach protocol, and [jattach](https://github.com/jattach/jattach) is a single ~50KB static binary that does exactly that. We copied it into the only writable place the pod had — the emptyDir we already mounted for tmp:

```console
$ kubectl cp ./jattach orders-api-7d9f6c5b48-x2klm:/tmp/jattach
$ kubectl exec orders-api-7d9f6c5b48-x2klm -- /tmp/jattach 1 dumpheap /tmp/heap.hprof
Connected to remote JVM
JVM response code = 0
Dumped heap to /tmp/heap.hprof
```

Two things to know before you rely on this. First, `kubectl cp` uses `tar` under the hood, and a sufficiently minimal image doesn't have tar either — ours did, barely, because the jlink image was built on a distro base. (If it hadn't: `kubectl exec -i ... -- sh -c 'cat > /tmp/jattach' < ./jattach` works with nothing but a shell.) Second, the attach socket requires matching UIDs; we ran as the same non-root user the JVM did, so it worked. Attaching from a different UID, or across certain container boundaries, fails with `Operation not permitted`.

## Attempt 3: The ephemeral debug container

If we hadn't been able to write to the pod at all, the modern answer is an ephemeral container with a full JDK, targeting the app container's process namespace:

```console
$ kubectl debug -it orders-api-7d9f6c5b48-x2klm \
    --image=eclipse-temurin:21-jdk \
    --target=orders-api -- bash

debugger@orders-api:~$ jcmd 1 GC.heap_dump /tmp/heap.hprof
```

The `--target` flag is the load-bearing part: it shares the app container's PID namespace so `jcmd` can see PID 1. Same-UID rules still apply — run the debug container as the app's user (`kubectl debug` doesn't expose this directly; we keep a pre-built debug image whose default UID matches our app images). And note `/tmp` here must be a *shared volume*, because ephemeral containers get their own filesystem; the emptyDir mounted into both is what makes the dump reachable. Our platform team has `EphemeralContainers` enabled and our RBAC allows `pods/ephemeralcontainers` patch in our namespace — check yours before an incident, not during. There's a fuller walkthrough in [Heap dumps on JRE-only images](/java/heap-dumps-jre-only/).

## Attempt 4: Getting 4GB out of the pod

We now had `/tmp/heap.hprof`: 4.1GB. `kubectl cp` on a file that size over our VPN was projected at 50 minutes and died twice at around 15 — it has no resume, so each failure meant starting over. What finally worked was compressing first (hprofs of leaky heaps compress absurdly well — repeated leaked objects are repeated bytes) and streaming without tar:

```console
$ kubectl exec orders-api-7d9f6c5b48-x2klm -- gzip -k /tmp/heap.hprof
$ kubectl exec orders-api-7d9f6c5b48-x2klm -- sh -c 'cat /tmp/heap.hprof.gz' \
    > heap.hprof.gz
$ ls -lh heap.hprof.gz
-rw-r--r--  1 me  staff  612M Feb  3 17:20 heap.hprof.gz
```

612MB moved in four minutes. (Verify integrity with a checksum on both ends; a truncated hprof fails in the analyzer with maximally confusing errors.) More options — including dumping straight to a sidecar with object storage credentials — are in [Getting dumps out of a pod](/java/getting-dumps-out/).

## The anticlimax, and the accounting

The leak itself was almost boring: an unbounded Caffeine cache keyed on a request header that a partner had started sending with a UUID in it. Eclipse MAT's dominator tree put 2.9GB under one `BoundedLocalCache`, the histogram showed 11 million entries where we expected a few thousand, and the keys made the diagnosis for us:

```text
Class Name                                   | Objects    | Retained Heap
com.github.benmanes.caffeine.cache.PSMS      | 11,204,881 | 2,912,440,336
  key: "tenant-ctx:7f3a9c1e-44d2-4b8a-..."   |            |
  key: "tenant-ctx:8a01d5f2-9c3b-4e77-..."   |            |
```

Two-line fix: `maximumSize` and a saner cache key. The dump took three hours to obtain; reading it took twenty minutes. That ratio — acquisition 90%, analysis 10% — is inverted from what any of us would have estimated, and it's the number that drove everything in the next section. The full triage pattern is written up in [Memory leaks and OOM](/java/memory-leaks-and-oom/).

:::tip
The ratio in that last paragraph is the whole lesson. Analysis is fast when you have the artifact. Every minute of "how do we even get a dump" is a minute you chose not to spend during business hours, months earlier.
:::

## What we changed

- **Every JVM image now ships `jattach`** (~50KB) at a known path, even the jlink-minimized ones. Minimal images are great; un-debuggable images are not, and the delta is one static binary.
- **`-XX:+HeapDumpOnOutOfMemoryError` is validated, not just set.** The dump path must point at a mounted, writable `emptyDir` (sized in the pod spec so a dump can't evict the node), and our CI lints that the `HeapDumpPath` directory matches a volume mount in the same pod spec.
- **A staging chaos test actually OOMs a pod quarterly** and asserts an hprof appears. A safety net you've never seen catch anything is a hypothesis.
- **We built and registered a debug image** — JDK, matching UID, `async-profiler`, curl to object storage — and got the platform team to bless `kubectl debug --target` RBAC for our namespaces in writing.
- **The runbook now includes the tar-less copy incantations**, because 2am is not when you want to discover `kubectl cp` needs tar.

Bake dump-friendliness into the image and the pod spec before you need it. The alternative is doing archaeology with a teaspoon while production leaks.
