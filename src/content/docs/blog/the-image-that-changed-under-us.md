---
title: "Field Notes: The Image That Changed Under Us"
description: Half the pods in one Deployment crashed and half were fine — same spec, same tag, same everything. Except the tag no longer meant the same image, because someone upstream had moved it.
date: 2026-06-25
authors: editor
tags:
  - images
  - supply-chain
  - registries
  - debugging
excerpt: >-
  Three pods crashed, six were fine, and all nine were bit-for-bit identical in every YAML we could print — same Deployment, same ReplicaSet, same tag. We chased "haunted nodes" for half a day before comparing image digests across pods and finding two different images answering to one name.
---

Some incidents violate a specific belief you didn't know you were holding. Ours was: *pods from the same ReplicaSet run the same software.* It's so obviously true that nobody ever says it out loud. On a Tuesday in June, it was false for six hours.

## 09:20: three pods out of nine

Morning traffic ramped, the HPA scaled `checkout` from six pods to nine, and the three new pods went straight to `CrashLoopBackOff`. Not the app container — the telemetry sidecar, a vendor agent image we run unmodified next to every pod:

```console
$ kubectl get pods -l app=checkout
NAME                        READY   STATUS             RESTARTS   AGE
checkout-5f86c9d7b4-2xkvm   2/2     Running            0          6d
checkout-5f86c9d7b4-7hqzn   2/2     Running            0          6d
checkout-5f86c9d7b4-9wmtp   1/2     CrashLoopBackOff   6          9m
checkout-5f86c9d7b4-c4rjd   2/2     Running            0          6d
checkout-5f86c9d7b4-dn8vw   1/2     CrashLoopBackOff   6          9m
checkout-5f86c9d7b4-fp2ls   2/2     Running            0          6d
checkout-5f86c9d7b4-kt6mh   1/2     CrashLoopBackOff   5          9m
checkout-5f86c9d7b4-qs3bz   2/2     Running            0          6d
checkout-5f86c9d7b4-x9wfg   2/2     Running            0          6d
```

Same ReplicaSet hash on every pod. Nobody had deployed anything — `kubectl rollout history` confirmed the last rollout was six days old. The sidecar's crash log complained about an unknown key in its own config file... a config we hadn't touched in months, that six other copies of the *same container from the same spec* were parsing happily at that very moment.

The first hours went to the classic wrong theories. Bad nodes — the crashing pods were all on newer nodes, so: kernel version? Some node-local agent? We deleted a crashing pod; the scheduler put its replacement on an older node; it ran fine. Deleted a healthy one; it landed on a new node; it crashed. "Haunted nodes" was, at noon, our leading technical theory, which tells you how the morning was going. Since we don't own nodes, we opened a platform ticket asking what was different about the new ones. The eventual answer: "nothing — they're from the same template. But interesting: they were provisioned this morning." Fresh nodes. Empty image caches. Hold that thought.

## 13:40: one tag, two digests

The turning point was someone asking not "what's different about the nodes" but "is it actually the *same image* on both?" — a question that sounds paranoid until you run it:

```console
$ kubectl get pods -l app=checkout -o jsonpath='{range .items[*]}{.spec.nodeName}{"\t"}{.status.containerStatuses[?(@.name=="otel-agent")].imageID}{"\n"}{end}'
node-a1   ghcr.io/orbit-obs/otel-agent@sha256:7c1f42d8...
node-a1   ghcr.io/orbit-obs/otel-agent@sha256:7c1f42d8...
node-b7   ghcr.io/orbit-obs/otel-agent@sha256:e93ab016...
node-a3   ghcr.io/orbit-obs/otel-agent@sha256:7c1f42d8...
node-b7   ghcr.io/orbit-obs/otel-agent@sha256:e93ab016...
node-a4   ghcr.io/orbit-obs/otel-agent@sha256:7c1f42d8...
node-b8   ghcr.io/orbit-obs/otel-agent@sha256:e93ab016...
node-a2   ghcr.io/orbit-obs/otel-agent@sha256:7c1f42d8...
node-a2   ghcr.io/orbit-obs/otel-agent@sha256:7c1f42d8...
```

Every pod's spec said `image: ghcr.io/orbit-obs/otel-agent:1.31`. The `imageID` — what the runtime *actually resolved and ran* — showed **two different digests answering to that one tag**, split exactly along healthy/crashing lines. `kubectl describe pod` shows the same pair of facts, one asked-for and one actual, on any single pod:

```console
$ kubectl describe pod checkout-5f86c9d7b4-9wmtp | grep -A1 'Image:'
    Image:          ghcr.io/orbit-obs/otel-agent:1.31
    Image ID:       ghcr.io/orbit-obs/otel-agent@sha256:e93ab016...
```

There was no haunting. There were two different programs wearing the same name.

## The mechanism: a pointer, a cache, and a publisher in a hurry

Three facts, individually mundane, jointly an incident:

**1. Tags are mutable pointers.** A tag is not an image; it's a sticky note on one. The vendor had shipped a rebuild of `1.31` two days earlier — a CVE rebase, per their changelog, plus a config-schema tightening they considered harmless — and pushed it *to the same tag*. From their side, responsible hygiene. From ours, the meaning of a string in our pod spec changed overnight, with no PR, no diff, no deploy. Nothing in our git history changed because nothing in our git *had* changed.

**2. `imagePullPolicy: IfNotPresent` trusts the node's cache.** It's the default for any tag that isn't `latest`, and it means: pull only if no image with this tag is cached locally. Kubelets on our long-lived nodes had cached `1.31` weeks ago and saw no reason to ask again — a tag they had was a tag they had.

**3. New nodes have no cache.** The morning's fresh nodes pulled `1.31` and got whatever the tag pointed at *now*: the rebuilt image, whose stricter config parser rejected a legacy key in our ConfigMap. So which binary a pod ran was decided by the provisioning date of the node it landed on. The scheduler had unknowingly become the thing choosing our software version, which explained the perfect pod-deletion roulette from the morning.

It also explained something that had nagged us all day: **why hadn't staging caught this?** Staging runs the same tag, the same sidecar, the same config. But staging is small, its nodes are long-lived, and its kubelets were all sitting on the old cached image. Staging wasn't validating our manifests against the world; it was validating them against a snapshot of the world from three weeks ago, preserved by the same caching behavior that split production. A floating tag makes "staging matches prod" a statement about luck, not configuration — the two environments only agree until someone's cache expires or someone's node recycles, whichever comes first.

The short-term fix took five minutes once we could see it: pin the *old* digest directly in the pod spec, roll, done — every pod bit-for-bit identical again, on any node, regardless of cache:

```diff
       - name: otel-agent
-        image: ghcr.io/orbit-obs/otel-agent:1.31
+        image: ghcr.io/orbit-obs/otel-agent:1.31@sha256:7c1f42d8...
```

When both a tag and a digest are present, the digest is what's honored; the tag rides along purely for human eyes. Getting the digest to pin is a one-liner — from a healthy pod's `imageID` as above, or straight from the registry:

```console
$ crane digest ghcr.io/orbit-obs/otel-agent:1.31
sha256:e93ab0167f22...        # note: the registry now answers with the NEW digest
$ # the old one, at this point, existed only in our pods' status and node caches —
$ # which is exactly why we grabbed it from imageID and pinned it immediately
```

After the pinned rollout, verification was the same one-liner that broke the case, now with a boring answer:

```console
$ kubectl get pods -l app=checkout \
    -o jsonpath='{range .items[*]}{.status.containerStatuses[?(@.name=="otel-agent")].imageID}{"\n"}{end}' \
    | sort | uniq -c
   9 ghcr.io/orbit-obs/otel-agent@sha256:7c1f42d8...
```

Nine pods, one digest, on a mix of old and new nodes. That `uniq -c` output — one line, count equal to your replica count — is what "same spec, same software" looks like when it's actually true.

We then fixed the config key at leisure and moved to the rebuilt image the following week — deliberately, via a PR that changed the digest, reviewed like any other change. Which is the entire point: **the vendor's rebuild was probably fine. What was not fine was consuming it by accident, per-node, mid-morning, with no diff anywhere.**

### Wouldn't `imagePullPolicy: Always` have fixed this?

It came up in the postmortem, so let's retire it: `Always` doesn't mean "re-pull the whole image every time" (the layer cache still applies — it re-resolves the tag and pulls what's missing), and more importantly it solves the wrong problem. With `Always`, every pod restart after the vendor's push would have picked up the new image — so instead of three crashing pods and six healthy ones, we'd have converged on *nine* crashing pods as restarts rolled through, still with no deploy, no diff, and no idea why. `Always` buys you **consistency**; it does nothing for **identity**. The bug wasn't that our pods disagreed with each other — that was the *clue*. The bug was that none of them were guaranteed to be running the thing we validated. Only a digest says that.

:::note
`kubectl describe pod` shows both fields — `Image:` (what you asked for) and `Image ID:` (what you got). Any time one Deployment behaves like two, comparing `imageID` across pods should be minute-five work, not hour-five. Same trick applies to "works in staging, fails in prod" when both run "the same tag."
:::

## What we changed

- **Every image we don't build is pinned by digest** — sidecars, init containers, vendor agents, the lot. A bot (Renovate-style) watches upstream tags and opens PRs that bump the digest, so updates arrive as *reviewable diffs* with changelogs attached instead of as cache-miss surprises. The tag stays in the string for readability; the digest is the contract. Details in [supply-chain security](/operations/supply-chain-security/).
- **Everything we depend on is mirrored.** The platform team stood up a pull-through registry mirror, and our manifests now reference upstream images through it. Digest pinning protects you from a tag *moving*; the mirror protects you from the image *vanishing* — a publisher who force-pushes tags will eventually delete one you're running, and "the registry is down" stops being your outage.
- **Our own Dockerfiles got the same audit.** The postmortem grep found four `FROM` lines on floating tags like `21-jre` — the identical failure mode moved one step left, into the build: two CI runs of the same commit could produce different images. Base images are now digest-pinned and bot-bumped, so a base change is a commit, and every image is reproducibly *something specific*. Our [CI/CD pipeline design](/operations/cicd-pipeline-design/) notes now treat an unpinned reference as a build error.
- **Triage got a new early question: "same spec" is a claim about YAML — verify it's true of the *binaries*.** The `imageID` one-liner from this incident is pasted into the [triage methodology](/troubleshooting/triage-methodology/) runbook under split-brain symptoms, right next to "what changed?" — because the honest answer to "what changed?" was *someone else's registry*, which no amount of staring at our own history would ever surface.
- **We stopped saying "version" when we mean "tag."** Small cultural change, real effect: in design docs and reviews, "we run 1.31" now gets the follow-up "which digest?" A tag is a claim someone else can falsify retroactively. A digest is content-addressed truth.

The belief we lost was a comfortable one: that our pod spec named our software. It never did — it named a pointer, plus a caching policy, plus whatever the pointer's owner did last Tuesday. Pin the digest and the name becomes the thing. Leave the tag floating, and somewhere out there is a stranger with push access to your Deployment.
