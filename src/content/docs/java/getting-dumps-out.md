---
title: Getting Dumps Out of the Pod
description: Moving multi-gigabyte heap dumps and recordings from a pod to your laptop — kubectl cp, its tar dependency, raw-stream fallbacks, and helper pods.
sidebar:
  order: 5
---

You captured a 4 GiB `.hprof`. It's sitting in `/dumps` inside a container
with no scp, no rsync, and possibly no shell. This article is the plumbing:
every reliable way to move big files out through the only channel you have —
the Kubernetes API — plus the cleanup discipline that keeps the pod alive
while you do it.

## kubectl cp: the happy path, with a tar-shaped asterisk

```bash
kubectl cp myapp-7d4b9c6f5d-x2klm:/dumps/java_pid7.hprof ./java_pid7.hprof
```

`kubectl cp` is not a file-transfer protocol; it's sugar for
`kubectl exec ... tar cf - <path>` piped to a local `tar xf -`. Which means
**the container image must contain `tar`**. When it doesn't, you get the
famous:

```console
error: Internal error occurred: error executing command in container:
failed to exec in container: ... exec: "tar": executable file not found in $PATH
```

Distroless and jlink-minimal images fail exactly this way. Also note
`kubectl cp` has no resume and historically weak integrity guarantees on
flaky connections — for multi-GiB files over a VPN, prefer the explicit
stream + checksum below even when tar exists.

## Fallback 1: raw stream over exec

`kubectl exec` gives you the process's stdout as a byte stream, and kubectl
does not mangle it when stdout is redirected (no `-t`! a TTY *will* corrupt
binary data by translating line endings):

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- cat /dumps/java_pid7.hprof > java_pid7.hprof
```

No shell needed if `cat` exists (busybox: yes; distroless static: no).
Variants when `cat` is missing but a shell exists:

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- sh -c 'dd if=/dumps/java_pid7.hprof bs=1M' > java_pid7.hprof
# or pure shell builtin redirection:
kubectl exec myapp-7d4b9c6f5d-x2klm -- sh -c 'exec 3</dumps/java_pid7.hprof; cat <&3' > java_pid7.hprof
```

**Always verify the transfer.** Exec streams can truncate silently if the
connection drops:

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- sh -c 'sha256sum /dumps/java_pid7.hprof; wc -c < /dumps/java_pid7.hprof'
sha256sum java_pid7.hprof && wc -c < java_pid7.hprof
# compare both hash and byte count
```

### Base64 armor, when you don't trust the pipe

Some setups (Windows terminals, exotic proxies, tools that insist on a TTY)
corrupt raw binary. Base64 costs 33% more bytes but survives anything that
passes text:

```bash
kubectl exec myapp-7d4b9c6f5d-x2klm -- base64 /dumps/java_pid7.hprof | base64 -d > java_pid7.hprof
# macOS: base64 -D; GNU coreutils: base64 -d
```

`base64` exists in busybox and most slim images; it does not exist in
distroless — there, use the ephemeral-container route below.

### Splitting large files

For a 10 GiB dump over a connection that drops every 20 minutes, split into
chunks and pull them individually — a failed chunk retries cheaply:

```bash
kubectl exec $POD -- sh -c 'cd /dumps && split -b 512m java_pid7.hprof part- && ls part-*'
for p in $(kubectl exec $POD -- sh -c 'ls /dumps/part-*'); do
  kubectl exec $POD -- cat "$p" > "$(basename $p)"
done
cat part-* > java_pid7.hprof
kubectl exec $POD -- sh -c 'rm /dumps/part-*'   # you doubled disk usage; clean it now
```

Note `split` doubles the space needed on the volume. Check free space first:
`kubectl exec $POD -- df -h /dumps`.

## Compress first — always worth it

Heap dumps compress extremely well (typically 3–10×: they're full of zeroed
arrays and repeated strings). A 6 GiB `.hprof` often gzips to under 1.5 GiB.
If the image has gzip:

```bash
kubectl exec $POD -- gzip /dumps/java_pid7.hprof        # in place: needs ~equal free space during compression
kubectl exec $POD -- cat /dumps/java_pid7.hprof.gz > java_pid7.hprof.gz
```

If it doesn't, bring gzip in a busybox ephemeral container that shares the
volume via the *target's* filesystem:

```bash
kubectl debug -it $POD --image=busybox --target=myapp -- sh
# inside — the app's filesystem is reachable through /proc/<jvm pid>/root:
gzip /proc/7/root/dumps/java_pid7.hprof
```

(That works because `--target` shares the pid namespace, and `/proc/<pid>/root`
traverses into the target container's mount namespace — provided the debug
container runs as root or the same UID.) Then stream the `.gz` out via the
debug container, which definitely has `cat`. MAT opens `.hprof.gz` directly
in recent versions; otherwise `gunzip` locally.

## The distroless end-boss: ephemeral container with tar

No shell, no cat, no base64 in the app container? An ephemeral container
brings all of them, plus tar for a proper `kubectl cp`:

```bash
kubectl debug $POD --image=busybox --target=myapp --container=puller -- sleep 3600
# now cp *from the ephemeral container*, reaching the app's files via /proc:
kubectl cp $POD:/proc/7/root/dumps/java_pid7.hprof ./java_pid7.hprof -c puller
```

If `/dumps` is a pod volume (emptyDir/PVC), an even cleaner alternative
exists — mount the volume elsewhere.

## Helper pod on a shared PVC

If dumps go to a **PVC** (recommended for anything you do routinely), you
don't have to fight the app container at all. Mount the same claim in a
throwaway pod that has real tools:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: dump-puller
spec:
  containers:
    - name: puller
      image: busybox:1.36
      command: ["sleep", "7200"]
      volumeMounts:
        - name: dumps
          mountPath: /dumps
  volumes:
    - name: dumps
      persistentVolumeClaim:
        claimName: myapp-dumps
```

```bash
kubectl apply -f dump-puller.yaml
kubectl cp dump-puller:/dumps/java_pid7.hprof ./java_pid7.hprof
kubectl delete pod dump-puller
```

Caveat: many PVCs are `ReadWriteOnce` — attachable to one *node* at a time —
so the helper pod may need to land on the same node as the app pod (it
usually can: RWO is per-node, not per-pod). If scheduling fights you, use
`spec.nodeName` pinning... which you can set, since it's your pod spec. An
`emptyDir` can't be mounted by a second pod at all — for emptyDirs, use the
ephemeral-container routes above.

## Realistic sizes and patience

| File | Typical size | Over 50 Mbit/s VPN |
|---|---|---|
| Thread dumps (5×) | < 1 MB | instant |
| GC log, JFR recording | 10–200 MB | seconds–minutes |
| Heap dump, 2 GiB heap | ~2 GiB (~500 MB gzipped) | ~1.5 min gzipped |
| Heap dump, 8 GiB heap | ~8 GiB (~1.5–2 GiB gzipped) | 5–10 min gzipped |

The API-server path (exec/cp) also traverses the kubelet and can be slower
than raw network; some clusters rate-limit it. Start the transfer, go write
up the incident timeline, come back.

:::caution[Clean up, or the evidence kills the patient]
Dumps on the container's writable layer or an emptyDir count toward the
pod's **ephemeral-storage** accounting. Blow past the limit (or the node's
disk-pressure threshold) and the kubelet *evicts the pod* — destroying the
emptyDir and your dump with it. After every capture-and-pull:

```bash
kubectl exec $POD -- sh -c 'rm -f /dumps/*.hprof /dumps/part-* /dumps/*.gz && df -h /dumps'
```

And remember `-XX:+HeapDumpOnOutOfMemoryError` won't overwrite an existing
file — a leftover dump means the next OOM captures nothing.
:::

Where the dumps come from: [thread dumps](/java/thread-dumps-jre-only/),
[heap dumps](/java/heap-dumps-jre-only/), and
[JFR recordings](/java/java-observability/). For the eviction mechanics you're
avoiding, see [OOMKilled and friends](/troubleshooting/oomkilled/).
