---
title: "Field Notes: The Oracle Database That Hated Time Travel"
description: An Oracle pod stuck in a CrashLoopBackOff with ORA-01012, and the trail that led through clock drift, Apple Silicon VM virtualization, and time-stabilizing host sleep guards.
date: 2026-07-05
authors: editor
tags:
  - stateful
  - databases
  - debugging
  - virtual-machines
excerpt: Oracle Database Free on a local Apple Silicon VM went down and refused to come back up. The container log blamed a generic ORA-01012 error, but the real root cause was QEMU's system counter drifting during host sleep events.
---

Our local Oracle Database Free pod (`oracle-oracle-0`) was stuck in a `CrashLoopBackOff` loop. `describe` reported it had restarted 18 times, exiting with exit code 1 just a single second after every start attempt.

The container logs showed the listener starting up cleanly, followed immediately by:

```console
ORA-01012: not logged on
############################################
DATABASE STARTUP FAILED!
############################################
```

When Oracle Database fails to boot in less than a second with `ORA-01012`, it usually means something aborted the startup script mid-execution. But because the container crashed immediately, we couldn't run standard diagnostics or exec inside. Here is how we tracked down a time-travel anomaly inside a local virtualized cluster.

## Ruling out resource pressure

First, we checked for node taints or eviction events. `kubectl describe node` showed no `MemoryPressure` or `DiskPressure`. The node was `Ready`, and the container limits were set to 4Gi of memory. This was a clean exit, not an OOM-kill.

## Spinning up a debug pod to inspect the alert log

Because the container exited so quickly, the diagnostic details were lost. We scaled the StatefulSet down to 0 to free up the PersistentVolume:

```bash
kubectl scale statefulset oracle-oracle --replicas=0 -n oracle
```

Then we spun up a temporary, sleep-locked debug pod mounting the same PVC:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: oracle-debug
  namespace: oracle
spec:
  containers:
    - name: debug
      image: container-registry.oracle.com/database/free:latest
      command: ["sleep", "infinity"]
      volumeMounts:
        - name: data
          mountPath: /opt/oracle/oradata
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: data-oracle-oracle-0
```

Once inside the debug pod, we launched `sqlplus / as sysdba` and ran a manual startup sequence:
1. `startup mount` — Succeeded.
2. `alter database open` — Succeeded.

Both PDBs (`FREE` and `FREEPDB1`) came up successfully in `READ WRITE` mode. The datafiles were completely intact. This wasn't a case of data corruption, but a failure of the container's standard entrypoint script.

We dug into the database alert log (located in the trace directory of the diagnostic destination) and found the smoking gun:

```text
--ATTENTION--
Time stalled at 1719830400
Time stall, backward drift ended at 1719830540 with drift ~140000
```

The system clock was stalling and drifting backward.

## The virtualization time-travel trap

The local cluster was running inside a Lima/QEMU VM on Apple Silicon, which uses `arch_sys_counter` as its clocksource. We discovered two key issues:

1. **Continuous micro-stalls**: Under emulation, the virtualized guest clock stalls and drifts backward by ~140ms every 20 seconds.
2. **Suspended state jumps**: When the Mac host goes to sleep or suspends, the VM's clock freezes completely. Upon host wake, the guest clock jumps backward relative to real time.

Oracle Database's kernel is highly sensitive to time consistency. If it detects a backward time jump during initialization, the instance immediately aborts as a safety precaution. This explained the 1-second crash loop: the host had gone to sleep, the VM clock drifted, and the database aborted on every reboot attempt.

## The recovery

Since the clock had stabilized once the host woke up, we performed a clean database recovery:
1. Ran a manual `shutdown immediate` from our debug pod to ensure the datafiles were marked consistent.
2. Deleted the debug pod.
3. Scaled the StatefulSet back to 1.

The stock entrypoint reached `DATABASE IS READY TO USE` and the pod transitioned to `1/1 Ready`.

## Preventing recurrence

To prevent the host from sleeping while the virtualized cluster is active, we added a helper script, `scripts/caffeinate-guard.sh`, which runs `caffeinate -ims` (preventing system and disk sleep) as a background daemon whenever a local VM is running:

```bash
#!/bin/bash
# scripts/caffeinate-guard.sh
# Prevent host sleep while local Lima VMs are running

while limactl list | grep -q "Running"; do
  caffeinate -ims -t 60
  sleep 30
done
```

This prevents the time-freeze events that cause Oracle to self-destruct upon wake. 

> [!TIP]
> Deleting the pod is not a magic fix for clock drift. If the host clock is actively drifting, a recreated pod will hit the exact same startup failure. The real fix is ensuring clock stability on the host machine.
