---
title: "Field Notes: The Readiness Probe That Took Down Prod"
description: A downstream dependency blipped for 30 seconds; our readiness probes turned it into a fleet-wide 100% outage — a postmortem on probe semantics.
date: 2026-06-15
authors: editor
tags:
  - availability
  - health-checks
  - networking
excerpt: A cache cluster hiccuped for thirty seconds. Our service could have limped through it degraded. Instead, every pod in the fleet declared itself NotReady in the same five seconds, the EndpointSlices emptied, and we served 503s to everybody — a total outage we wrote ourselves, one probe at a time.
---

Here is the entire root cause, four lines of YAML that passed review with a "nice, thorough":

```yaml
readinessProbe:
  httpGet:
    path: /health/full     # checks DB, cache, *and* downstream quote-svc
    port: 8080
  periodSeconds: 5
  failureThreshold: 2
```

The `/health/full` endpoint was proud of itself. It checked the database, it checked Redis, and it made a live call to `quote-svc`, our pricing dependency. If anything a request *might* need was unhappy, the pod reported unhealthy. Thorough. Honest. Catastrophically wrong — and it took eleven months to prove it.

## The timeline, from the events log

On June 3rd, `quote-svc`'s Redis cluster did a failover. Total blip: about 30 seconds of elevated errors on one downstream dependency, the kind of thing that happens to every distributed system every month. Here's what our fleet of 40 `storefront-api` pods did with it (reconstructed from `kubectl get events` and the [events archive](/observability/events/) — this timeline is the most instructive artifact we've ever put in a postmortem):

```text
10:14:02  quote-svc Redis failover begins; quote-svc p99 spikes
10:14:05  first storefront-api readiness probes hit /health/full,
          which calls quote-svc, which is slow -> probe timeout (1s)
10:14:10  second consecutive failure on the early pods
          (failureThreshold: 2) -> pods marked NotReady
10:14:15  Warning  Unhealthy  Readiness probe failed: HTTP 503
          ... x40 pods. every pod probes on the same period, every
          probe checks the same dependency: perfectly correlated.
10:14:20  EndpointSlices for storefront-api: 0 ready endpoints
10:14:20  ingress -> Service has no endpoints -> 503 for ALL traffic
10:14:35  quote-svc Redis failover completes; quote-svc healthy
10:14:45  probes need successThreshold (1) + a passing period to
          recover... but now 100% of retry traffic + queued clients
          slam the first pods to go Ready
10:15:10  first 3 pods Ready -> receive the entire fleet's traffic
          -> saturate -> /health/full times out under load -> NotReady
10:15:30  next pods Ready -> same stampede, same collapse
10:22:00  engineer scales quote-svc check out of the loop by...
          nothing. engineer watches pods flap. 503s continue.
10:31:00  full recovery only after manually raising failureThreshold
          and letting pods stay Ready through the thundering herd
```

Read 10:14:20 again. **Zero ready endpoints.** The dependency was degraded — maybe 40% of requests would have failed pricing and could have served cached quotes or a friendly error on one page. Our probes converted a 30-second, partial, *downstream* degradation into a 17-minute, total, *fleet-wide* outage. The blip broke one feature; our health checks unplugged the store. And the recovery flapping at 10:15 was pure probe physics: readiness gates traffic, so the first pods to recover inherit everyone's traffic and get re-failed by their own health endpoint. We built a system whose failure mode was to bite anything that tried to heal it. (If you've ever debugged "Service has no endpoints," this is one of the classic paths into [service unreachable](/troubleshooting/service-unreachable/).)

## The semantics we had wrong

The mental model that produced that YAML: *readiness = "is this pod healthy?"* — a little status LED, and honesty is a virtue, so check everything.

The actual semantics: **readiness is a traffic-routing lever.** NotReady means "remove me from the Service's [EndpointSlices](/networking/services-deep-dive/)" — nothing more, nothing less. So the only question a readiness probe should answer is: *would sending a request to this specific pod produce a worse outcome than sending it to another pod, or to no pod?*

Run our incident through that question. When `quote-svc` blipped, was `storefront-api-x` worse than its 39 siblings? No — they were all equally degraded, because the problem wasn't *in* any pod. Removing one pod routed around nothing; removing all of them routed around the entire application. That's the core rule we now teach:

> **A readiness probe should only check things that differ between replicas.** My process is up, my listeners bound, my local caches warmed, my initialization finished. Shared dependencies fail *shared* — and a check on a shared dependency doesn't take the sick pod out of rotation, it takes the *fleet* out of rotation, exactly when you need every degraded pod you have.

Liveness is the same lever pointed at a bigger gun — kubelet restarts the container — and the same reasoning applies with more force: a liveness probe that checks a dependency turns "database slow" into "every JVM in the fleet restarting in sync, cold caches and all." Ours, mercifully, only checked the process. The [health checks guide](/workloads/health-checks/) has the full decision table; the incident-shaped summary is:

- **Liveness:** "am I wedged beyond self-recovery?" (deadlock, unrecoverable state). Never dependencies. Generous thresholds.
- **Readiness:** "can *this replica* accept traffic right now?" Local facts only, plus startup gating.
- **Dependency health:** belongs in circuit breakers, timeouts, fallbacks, and *alerts* — mechanisms that degrade one feature, not vaporize the fleet's endpoints.

## Fail open on dependencies

The replacement probe philosophy is "fail open": the deep dependency-checking endpoint still exists — it's genuinely useful — but it feeds dashboards and alerts, where a human interprets it. The probe gets the shallow endpoint:

```yaml
readinessProbe:
  httpGet:
    path: /health/ready      # local-only: server up, init done, not draining
    port: 8080
  periodSeconds: 5
  failureThreshold: 3        # ~15s of local failure before de-routing
livenessProbe:
  httpGet:
    path: /health/live       # process responsive, full stop
    port: 8080
  periodSeconds: 10
  failureThreshold: 6        # a restart is a big hammer; be slow to swing it
```

The handler behind `/health/ready` shrank to facts only this replica can know:

```java
// Local-only readiness. Deliberately boring.
boolean ready =
       server.isListening()
    && migrations.finished()
    && warmup.complete()
    && !shutdown.isDraining();   // flip NotReady *on purpose* during rollouts
// Note what's absent: no DB ping, no Redis ping, no quote-svc call.
```

That last line does honest work during deploys, by the way — readiness-as-a-lever is also how graceful shutdown and surge rollouts stay zero-downtime. The lever was never the problem; we'd just wired it to somebody else's weather.

And inside the app, `quote-svc` calls got what they should have had all along: a 400ms timeout, a circuit breaker, and a cached-quote fallback. In the next `quote-svc` blip — there's always a next one, and ours arrived July 9th — storefront served slightly stale prices for 40 seconds, the EndpointSlices never lost a single endpoint, and *nobody paged at all*. The only evidence was a breaker-open counter on a dashboard and one Slack message that said "huh, neat."

:::caution
One legitimate exception: if a pod truly cannot do anything useful without the dependency **and** downstream retries against a different pod could genuinely succeed (e.g., pods hold sharded connections), a dependency-aware readiness check can make sense — with a long failure threshold and a "degraded but Ready" middle state. Treat it as the exception you have to argue for, not the thorough default.
:::

## What we changed

- **Probe review is now a design review question with teeth:** for every readiness check, the author must answer "when this fails, will it fail on one replica or on all of them at once?" Anything correlated across the fleet is banned from probes and moved to alerting.
- **Two endpoints, permanently:** `/health/ready` (local-only, wired to probes) and `/health/full` (deep checks, wired to dashboards and synthetic monitoring). The thorough endpoint didn't die; it got a job it's qualified for.
- **Every hard dependency got a timeout, a breaker, and a written degraded mode.** "Fail open" only works if the request path actually survives the dependency being gone — the probe change without the fallback work would just have traded 503s for 500s.
- **Game day: we now inject a 60-second dependency brownout in staging quarterly** and assert the EndpointSlices never empty. The test that would have caught this costs ten minutes.
- **The postmortem's one-line summary went on the team wiki homepage:** probes are levers connected to the traffic system and the restart system — not dashboards. Wire a lever to a signal you don't want acted on automatically, and eventually the machine acts on it.

Thirty seconds of somebody else's Redis failover. Seventeen minutes of our own 503s. The gap between those two numbers was entirely made of YAML we wrote ourselves, feeling responsible while we did it.

The probe wasn't lying, either — that's the part that stings. Every pod really couldn't price a quote for thirty seconds. It just turns out that "tell the truth to the traffic router" and "tell the truth to the humans" are different jobs, and we'd given both to the same endpoint.
