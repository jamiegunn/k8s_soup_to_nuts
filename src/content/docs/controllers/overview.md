---
title: Controllers & Extensions Overview
description: Why everything in Kubernetes is a controller, and how to work with the CRDs, operators, and platform-installed extensions you consume but don't operate.
sidebar:
  order: 1
---

Here's the one idea that unlocks the rest of Kubernetes: **everything is a controller.**

A controller is a loop. It watches some declared state (your YAML, stored via the API server), compares it to what actually exists, and takes action to close the gap. Forever. It never runs a script "once" — it runs a comparison continuously. In pseudocode, every controller in the cluster is this:

```text
for {
    desired := read spec from API server
    actual  := observe the world (child objects, external systems)
    if desired != actual {
        do the smallest safe thing that moves actual toward desired
    }
    write what you saw into status
}
```

That's the Deployment controller, the scheduler, the kubelet, kube-proxy, cert-manager, your GitOps pipeline, and every operator you'll ever meet. Different nouns, same loop.

## Watch it happen once

Run one deploy and trace who did what. You type:

```console
$ kubectl apply -f deploy.yaml
deployment.apps/web created
```

You created exactly one object. Then the chain fires, with no coordinator anywhere:

1. The **Deployment controller** notices a Deployment with no matching ReplicaSet → creates `web-7d4b9c8f6d`.
2. The **ReplicaSet controller** notices a ReplicaSet demanding 3 pods that don't exist → creates 3 Pods.
3. The **scheduler** notices Pods with no `nodeName` → assigns nodes.
4. Each node's **kubelet** notices Pods assigned to it → pulls images, starts containers, runs probes.
5. The **EndpointSlice controller** notices ready pods matching your Service selector → adds their IPs.
6. **kube-proxy** (and your ingress controller, and MetalLB, and CIS...) notice new endpoints → reprogram traffic paths.

Now delete a pod by hand. The ReplicaSet controller notices 2 < 3 and replaces it — usually before you've finished typing `kubectl get pods`. Kill a node: the node lifecycle controller notices missed heartbeats, marks pods for eviction, and steps 2–6 rebuild everything elsewhere. Nobody orchestrated any of this end to end; each controller understands only its one small job, and coherent behavior emerges from the chain.

Once you internalize this, your troubleshooting instincts change permanently: you stop asking *"what command do I run to fix it?"* and start asking *"which controller owns this transition, and why isn't it acting?"*

## Why this section exists

You own applications, not the cluster. That constraint shapes everything here:

- **Built-in controllers** (Deployment, ReplicaSet, Job, HPA, garbage collector...) run inside the control plane. You can't see their logs, restart them, or configure them. You interact with them purely through the API objects they watch — spec in, status and Events out.
- **Extensions** (MetalLB, F5 CIS, CSI drivers, admission webhooks, operators) are installed by the platform team, because CRDs and cluster-scoped controllers require cluster-admin rights. You consume them through **namespaced custom resources** — YAML you *can* write and deploy through your normal pipeline.

That split — *they operate the controller, you drive it with resources* — is the working model for every article in this section. It's also why the section spends so much time on reading `status`, `conditions`, and Events: those are the controller's side of the conversation, and often the only side you can see.

## The map

| Article | What you'll get |
|---|---|
| [Reconciliation](/controllers/reconciliation/) | The control loop itself: observe → diff → act, level-triggered design, ownerReferences, finalizers, and how to stop fighting the machine |
| [CRDs Explained](/controllers/crds-explained/) | How the API gets new types, how to discover what's installed in your cluster, and what happens when a CRD disappears |
| [Operators](/controllers/operators/) | CRD + controller + baked-in ops knowledge; debugging an operator-managed app when you can't read the operator's logs |
| [MetalLB](/controllers/metallb/) | Where your `type: LoadBalancer` external IP actually comes from on bare metal; L2 vs BGP; the `<pending>` Service playbook |
| [How MetalLB Chooses the Node](/controllers/metallb-node-selection/) | The mental model for *why one node (L2) or many (BGP)* answers for a VIP bound to no interface, and how to see the chosen node |
| [F5 CIS](/controllers/f5-cis/) | The controller that programs BIG-IP from your Ingress/VirtualServer resources — and why people wrongly call it "F5 CSI" |
| [CSI Drivers](/controllers/csi-drivers/) | The storage extension point: provision → attach → mount, and where each stage fails |
| [Storage Controllers](/controllers/storage-controllers/) | What's actually behind your StorageClass — Longhorn, Ceph, Harvester, OpenEBS, NFS — and how each one fails differently |
| [Admission Webhooks](/controllers/admission-webhooks/) | The gatekeepers that mutate or reject your manifests on the way into etcd — and the outage mode where a dead webhook blocks every deploy |

## Consume vs. operate — know which side you're on

When something breaks, this table tells you whether to debug it yourself or file a ticket (with evidence — every article here shows you exactly what evidence to gather):

| Thing | You | Platform team |
|---|---|---|
| Deployment/ReplicaSet/Job controllers | Write the specs, read status and events | Run the control plane |
| CRDs (the definitions) | Discover with `kubectl get crds`, read with `kubectl explain` | Install, upgrade, version them |
| Custom resources (CRs) in your namespace | Create, update, delete — this is your interface | — |
| Operators (the controller pods) | Read your CR's status/conditions/events | Install, upgrade, read controller logs |
| MetalLB pools, BGP peers | Read the CRs to understand behavior, annotate Services | Define pools, peer with routers |
| F5 CIS + BIG-IP | Author VirtualServer/Ingress resources | Run CIS, own the BIG-IP |
| CSI drivers, StorageClasses | Pick a class in your PVC, read events | Install drivers, define classes |
| Admission webhook configs / policies | Comply, read rejection messages, gather evidence | Install and scope the webhooks |

A useful habit: before touching anything during an incident, say out loud which row you're in. Half of the wasted hours we've seen came from app teams trying to fix a platform row (impossible from their seat) or filing tickets for an app row (slow, and embarrassing when the fix was a label typo).

## Spotting a controller's fingerprints

You'll regularly meet behavior you didn't configure and need to identify which loop caused it. Controllers leave consistent evidence:

**Objects you didn't create.** Check `ownerReferences` and walk up the chain:

```console
$ kubectl get pod web-7d4b9c8f6d-x2klp \
    -o jsonpath='{range .metadata.ownerReferences[*]}{.kind}/{.name}{"\n"}{end}'
ReplicaSet/web-7d4b9c8f6d
```

No ownerReferences but suspiciously systematic labels/annotations? Look at `metadata.labels` for `app.kubernetes.io/managed-by` — operators and tooling usually sign their work.

**Fields you didn't write.** `kubectl get <obj> -o yaml --show-managed-fields` lists every field's *manager* — the identity that last wrote it:

```console
$ kubectl get deploy web -o yaml --show-managed-fields | grep -A1 'manager:'
  - manager: kubectl-client-side-apply
  - manager: kube-controller-manager
  - manager: argocd-controller
```

That one flag settles most "who keeps changing my replicas?" arguments in thirty seconds.

**Events you didn't cause.** Every controller emits Events with a `source` component name; `kubectl get events --sort-by=.lastTimestamp` in your namespace is a running commentary of which loops touched what, for about an hour before events expire ([Events](/observability/events/)).

## Controllers you already depend on and have never thought about

Beyond the famous ones, a production request touches a dozen quiet loops. A sampler — each one is invisible until the day it isn't:

| Controller | Its quiet job | When you notice it |
|---|---|---|
| EndpointSlice controller | Keeps Service endpoints matching ready pods | Traffic drops to a pod that failed readiness — that was the point |
| Namespace controller | Deletes everything inside a deleted namespace | Namespace stuck `Terminating` on a finalizer |
| ServiceAccount + token controllers | Ensure `default` SA and mounted tokens exist | Pod won't start in a brand-new namespace for a few seconds |
| Garbage collector | Deletes orphans whose owners are gone | `--cascade=orphan` leftovers quietly vanish later than expected |
| Node lifecycle controller | Taints/evicts on unhealthy nodes | Your pods "randomly" reschedule during node trouble |
| PV protection / PVC protection | Finalizers preventing in-use storage deletion | The stuck-Terminating PVC classic |
| CronJob controller | Materializes Jobs on schedule | Skipped runs after downtime (`startingDeadlineSeconds`) |
| certificate/csr, TTL, PDB controllers... | ...and twenty more | Rarely — which is the compliment |

You don't need to memorize these. You need the reflex: *unexplained behavior → some loop's fingerprints → find it via owners, managers, and events* — not "Kubernetes is haunted."

## Vocabulary you'll need

Five terms recur through every article; here's the thirty-second version:

- **spec** — desired state. You write it; controllers only read it.
- **status** — observed state. Controllers write it; you only read it. (It's a separate API subresource — your `kubectl apply` can't corrupt it.)
- **conditions** — structured status entries (`Type`, `Status`, `Reason`, `Message`). The `Message` on a `False` condition is where controllers explain themselves. Read them before anything else.
- **ownerReferences** — the pointer from child to parent (Pod → ReplicaSet → Deployment) that powers cascading deletes and tells you which object to actually edit.
- **observedGeneration** — the last spec revision the controller processed. If it lags `metadata.generation`, the controller hasn't even *seen* your change — a completely different problem than "saw it and failed."

:::tip[The universal debugging pattern]
Every extension in this section is debugged the same way from your seat: `kubectl describe` the resource you created (read **status** and **conditions**), then `kubectl get events --sort-by=.lastTimestamp` in your namespace, then compare `generation` to `observedGeneration`. If all three come up empty, the problem is inside the controller itself — that's a platform ticket, and you attach exactly what you just collected. This pattern works on Deployments, operator CRs, VirtualServers, and PVCs alike; learn it once.
:::

:::caution[The universal anti-pattern]
Editing an object a controller owns. Your change to a ReplicaSet, an operator-created StatefulSet, or a CIS-generated config will be silently reverted the next time the loop runs — possibly at 3 a.m., possibly triggering a restart you didn't plan. Always edit the topmost object a human or pipeline created. The [Reconciliation](/controllers/reconciliation/) article explains why, and the sanctioned escape hatches.
:::

## Where to start

If you read only one article here, read [Reconciliation](/controllers/reconciliation/). It explains why `kubectl delete pod` gets you a new pod, why hand-edits to controller-owned objects vanish, and why your CI/CD pipeline and the cluster occasionally fight each other — the pipeline is just another controller, and that interaction has its own article in [Drift and CI/CD](/operations/drift-and-cicd/).

Then read the articles for whatever your cluster actually runs. Not sure what that is? [CRDs Explained](/controllers/crds-explained/) opens with the discovery commands — `kubectl get crds` and `kubectl api-resources` — that map any cluster you're dropped into in under a minute.

Everything else in this section — and honestly, most of Kubernetes — is that one loop wearing different hats.
