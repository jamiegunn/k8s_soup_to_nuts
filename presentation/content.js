// Single source of truth for both outputs: build-html.js and build-pptx.js read this.
// Audience: engineers with a strong development background and no devops background.

const SITE = "https://jamiegunn.github.io/k8s_soup_to_nuts";

module.exports = {
  meta: {
    title: "Kubernetes, from what you already know",
    subtitle: "You have built servers, sized pools, written health checks and shutdown hooks. Kubernetes asks three questions about all of it — here they are, and here is what to do when the answers go wrong.",
    footer: "For engineers who write the code · no devops background assumed",
    site: SITE,
    phrases: ["cost", "lifecycle", "response"],
  },

  slides: [
    // ---------------------------------------------------------------- 1
    {
      id: "bridge",
      eyebrow: "START HERE",
      title: "You already know most of this",
      kicker: "Kubernetes is not new physics. It is a runtime that asks about things you have been doing by hand for years — under unfamiliar names.",
      layout: "table2",
      table: {
        head: ["What you already do", "What Kubernetes calls it"],
        rows: [
          ["Size a thread pool so one service can’t exhaust the box", "`resources.requests` and `resources.limits`"],
          ["Expose `/health` so the load balancer stops sending to a sick instance", "`readinessProbe` — the only probe that gates traffic"],
          ["A watchdog that restarts a process that has wedged", "`livenessProbe` — it restarts you, it does not reroute you"],
          ["Finish in-flight work in a shutdown hook before exiting", "`preStop` + SIGTERM + `terminationGracePeriodSeconds`"],
          ["Stand v2 next to v1, then move traffic across", "a rolling update — `maxSurge` / `maxUnavailable`"],
          ["instances × `maxPoolSize` = what the database actually sees", "`maxReplicas` × pool size = your session budget"],
          ["`-Xmx` versus how much memory the box really has", "the container memory limit versus the JVM heap"],
        ],
      },
      callout: {
        label: "The point",
        text: "The vocabulary is new; the engineering is not. Where this deck says something surprising, it is almost always because the *default* differs from the one you would have chosen yourself.",
      },
      notes: "Open here and the room relaxes. Everyone in the audience has sized a pool and written a health check — the anxiety is that Kubernetes is a separate discipline, and it mostly isn't. Ask the room which row they have done most recently; whichever they name, that is the door you start with. The one row worth dwelling on is the last: the JVM heap and the container limit are two different numbers, and most first OOMKills come from assuming they are the same one.",
    },

    // ---------------------------------------------------------------- 2
    {
      id: "three-questions",
      eyebrow: "THE MODEL",
      title: "Kubernetes asks three questions",
      kicker: "Strip it to its job: a control loop that makes the cluster match what you asked for. To run one workload it needs exactly three things — and there is no fourth.",
      layout: "code-cards",
      code: {
        caption: "one Deployment, three doors",
        lines: [
          ["spec:", 0],
          ["  replicas: 2                              ", 3, "3 · Response — an HPA can own this"],
          ["  template:", 0],
          ["    spec:", 0],
          ["      terminationGracePeriodSeconds: 40    ", 2, "2 · Lifecycle — leaving"],
          ["      containers:", 0],
          ["        - name: payments-api", 0],
          ["          resources:", 0],
          ["            requests:                      ", 1, "1 · Cost — what is reserved"],
          ["              cpu: 250m", 1],
          ["              memory: 1Gi", 1],
          ["            limits:", 1],
          ["              memory: 1Gi                  ", 1, "request == limit"],
          ["          readinessProbe:                  ", 2, "2 · Lifecycle — arriving"],
          ["            httpGet: { path: /health/readiness, port: 8081 }", 2],
          ["          lifecycle:", 2],
          ["            preStop:                       ", 2, "2 · Lifecycle — the drain"],
          ['              exec: { command: ["sh","-c","sleep 5"] }', 2],
        ],
      },
      cards: [
        { n: "1", head: "Cost", text: "What does it reserve, and what happens when it goes over?" },
        { n: "2", head: "Lifecycle", text: "When should it get traffic, and when should it stop getting it?" },
        { n: "3", head: "Response", text: "How should the number of copies answer load?" },
      ],
      callout: {
        label: "Why it is a loop",
        text: "The request you set at Door 1 is the number the autoscaler divides by at Door 3, and Door 2 decides whether either number is believable. Get Door 1 wrong and Door 3 is wrong by the same factor.",
      },
      notes: "This is the slide to leave on screen while people ask questions. Everything else in the deck is inside one of these three. The YAML is deliberately a real fragment rather than a diagram — the audience will recognise a values file, and the colours say which door each stanza belongs to. If someone asks 'what about storage, networking, secrets?' — those are refinements inside a door, not a fourth door: a volume is a cost, a Service is downstream of readiness.",
    },

    // ---------------------------------------------------------------- 3
    {
      id: "door-cost",
      eyebrow: "DOOR 1 · COST",
      title: "One asymmetry decides everything",
      quote: "A CPU limit costs you latency. A memory limit costs you the process.",
      lead: "CPU is compressible: exceed your share and the kernel makes you wait. Memory is not — there is no ‘wait’, so the only move the kernel has is to kill. That single difference is why the two knobs are set in completely different ways.",
      layout: "quote-cards",
      cards: [
        { head: "Memory: request = limit", text: "Pin them together. You are then killed at exactly the number you reserved, with no surprising gap in between — and the scheduler has actually set that much aside for you." },
        { head: "CPU: set a request, think hard about a limit", text: "A quota throttles precisely the tail you are judged on. Plenty of teams deliberately run a CPU request with no CPU limit, and watch the throttle ratio instead." },
        { head: "The kill is not a Java exception", text: "`OOMKilled`, exit 137, is the kernel. Your `OutOfMemoryError` handling never runs, no stack trace is printed, and nothing in your code could have caught it." },
      ],
      callout: {
        label: "The JVM twist",
        text: "Your heap is only the biggest tenant of the container. Metaspace, thread stacks, the code cache and direct buffers live there too — which is exactly how a pod dies at its memory limit while every heap dump looks healthy.",
      },
      notes: "The asymmetry is the one sentence to engrave; if the audience remembers nothing else from this slide, that is enough. Expect pushback on 'no CPU limit' — the honest answer is that it depends on whether your platform's admission policy even allows it, and that the measurable consequence is the throttle ratio, which they can go and look at. The JVM twist is the most common first production incident for a Java team new to Kubernetes: heap at 60%, container dead.",
    },

    // ---------------------------------------------------------------- 4
    {
      id: "door-lifecycle",
      eyebrow: "DOOR 2 · LIFECYCLE",
      title: "Three probes, three different questions",
      layout: "cards-callout",
      cards: [
        { head: "startupProbe", sub: "“Have you finished booting?”", text: "Buys a slow JVM all the time it needs, without making the liveness probe permanently lenient." },
        { head: "readinessProbe", sub: "“Should I send you traffic right now?”", text: "The only probe that gates the Service. Failing it removes you from the load balancer — it does not restart you." },
        { head: "livenessProbe", sub: "“Are you wedged, so only a restart helps?”", text: "It must judge nothing but itself. If it can fail for a reason a restart cannot fix, it is wired wrong." },
      ],
      callout: {
        label: "The classic outage",
        text: "A readiness probe that checks a downstream dependency. The dependency blips for thirty seconds → every replica reports not-ready → every replica leaves the load balancer at once → a wobble becomes a 100% outage. Readiness answers for you, never for your dependencies.",
      },
      lead: "And leaving is half the door. When Kubernetes wants a pod gone, it removes the endpoint and sends SIGTERM at the same moment — these race. `preStop: sleep 5` lets endpoint removal propagate first; your shutdown hook then finishes in-flight work inside the grace period.",
      notes: "Ask the room what their liveness probe currently checks. In most Spring Boot services it is /actuator/health, which by default aggregates every health indicator including the database — that is the outage in the callout, waiting to happen, and the fix is one line pointing liveness at the liveness group. The shutdown half gets skipped in most introductions and then shows up as 502s on every deploy, which teams misread as a networking problem.",
    },

    // ---------------------------------------------------------------- 5
    {
      id: "door-response",
      eyebrow: "DOOR 3 · RESPONSE",
      title: "Scale on the thing that actually runs out",
      lead: "The autoscaler's arithmetic is `usage ÷ request`. It divides by the number you set at Door 1 — so a request nobody can defend produces scaling that is confidently wrong.",
      layout: "two-col",
      columns: [
        {
          head: "CPU is the default, not the answer",
          text: "Measured on a service that spends its time waiting on a database: across the point where latency broke its promise, CPU utilisation moved from 0.61 to 0.66. Busy threads moved from 0.58 to 0.94. An autoscaler watching CPU would never have fired.",
          foot: "Pick the number that saturates when the promise breaks — and was already moving one step earlier.",
        },
        {
          head: "The ceiling usually isn’t yours",
          text: "16 replicas × a connection pool of 10 = 160 database sessions. Past the budget the database refuses new connections — for everyone sharing it, not just for you. Your scale-out becomes the batch team's outage.",
          foot: "Before raising a replica ceiling, do the multiplication and find out whose number you are spending.",
        },
      ],
      callout: {
        label: "Re-check it",
        text: "Which number saturates first is a property of what a request *does*. Any release that adds a call to something slow can move it — so the signal is re-measured after the release, not inherited from last quarter.",
      },
      notes: "This is where a development audience is usually most confident and most wrong, because horizontal scaling feels free. The two columns are the two ways it isn't: the signal can be blind, and the ceiling can belong to someone else. The concrete numbers are from a real load test on the site; if anyone wants the derivation it is on the Oracle page. The transferable habit: whenever you are about to add replicas, ask what each replica multiplies.",
    },

    // ---------------------------------------------------------------- 6
    {
      id: "two-numbers",
      eyebrow: "WHEN NUMBERS FIGHT",
      title: "Both numbers are correct",
      layout: "story",
      story: [
        "`kubectl top` says the pod is using 40% of its CPU. The p99 has tripled. Someone says “we have headroom — it must be GC.” A week goes into GC flags, the database, and the network.",
        "The answer was a third number: the container was **throttled in 41% of its 100-millisecond scheduling periods** while *averaging* 31% of its limit. Bursty work meeting a quota. An average hides a wall you are hitting ten times a second.",
        "Neither instrument lied. They answer different questions, because they stand in different places — and there are only three places to stand.",
      ],
      cards: [
        { n: "1", head: "Outside the process", text: "The kernel's accounting for your container: CPU charged, periods throttled, bytes resident, kills delivered. Exact about what it cost; blind to what it was doing." },
        { n: "2", head: "Inside, continuously", text: "Your app measuring itself: requests by route, pool waits, heap by pool, GC pauses. Knows what it was doing — as an average, and as a sample every few seconds." },
        { n: "3", head: "Inside, on demand", text: "Stop it and ask: a thread dump, a heap histogram, a flight recording. Sees everything about one process right now, and only because you asked." },
      ],
      callout: {
        label: "The rule",
        text: "When two numbers disagree, don’t stare harder at one — change instrument. A number that makes no sense is usually a correct number read from the wrong place.",
      },
      notes: "Tell this as a story, not as a model — the audience has all lost a week to something like it. The throttle ratio is the specific takeaway: it is one query, most teams have never looked at it, and it explains a whole category of 'slow but the graphs look fine'. The three places generalise to every observability tool they will meet: a dashboard, a trace and an APM agent are all one of these three wearing different clothes.",
    },

    // ---------------------------------------------------------------- 7
    {
      id: "five-steps",
      eyebrow: "WHEN IT BREAKS",
      title: "Five things Kubernetes does to your pod",
      kicker: "Admit it, schedule it, start it, route to it, kill it — always in that order. Each step writes down why in exactly one place, and it is rarely the place you were looking.",
      layout: "table3",
      table: {
        head: ["What you see", "Which step failed", "Where the reason is written"],
        rows: [
          ["`helm upgrade` succeeds, no new pod appears", "Admit", "a `FailedCreate` event on the **ReplicaSet** — quota, policy, a webhook. No pod ever existed to carry it"],
          ["`Pending`, no node assigned", "Schedule", "the `FailedScheduling` event — one sentence naming every node's reason. Read past the first comma"],
          ["`ImagePullBackOff`, `CreateContainerConfigError`", "Start", "the waiting reason and its message — the registry's error, or the missing ConfigMap key"],
          ["`CrashLoopBackOff`", "Start ↔ Kill", "the last exit code, then `kubectl logs --previous`"],
          ["`Running` but `0/1` for minutes", "Route", "the readiness probe's own failure text, in the pod's events"],
          ["`RESTARTS` climbing", "Kill", "`lastState.terminated.reason` — `OOMKilled`, or `Error` beside a liveness event, or `Unknown`"],
        ],
      },
      callout: {
        label: "Three faults, one word",
        text: "`CrashLoopBackOff` means three different things. **Exit 1** is your code — `logs --previous` has its last words. **137 with `OOMKilled`** is the kernel at your memory limit. **137 beside a liveness event** is Kubernetes deciding you were wedged. And an empty log is not evidence about your app: it means the container never started.",
      },
      notes: "This is the highest-value slide for a team in its first month — 'my pod won't start' is the universal first experience. The discipline is walking down and stopping at the first failed step, because everything after a failed step also looks failed; people burn hours on Services for a pod that never got a node. If you demo one thing live, demo this: break a pod three different ways and show that the STATUS column is identical while the reason field is not.",
    },

    // ---------------------------------------------------------------- 8
    {
      id: "tuesday",
      eyebrow: "THIS WEEK",
      title: "Four things to do with your own service",
      layout: "steps",
      steps: [
        { head: "Open your values file and read it as three doors", text: "For every number in it, can you say where it came from? A request nobody can defend is the number your autoscaler is dividing by." },
        { head: "Check your readiness probe touches nothing but you", text: "Five minutes and one line. It is the most common way a thirty-second blip somewhere else becomes your full outage." },
        { head: "Read `kubectl get pods` as the five steps", text: "STATUS covers admit, schedule and start; READY is route; RESTARTS is kill — and a young AGE during an old incident means the evidence already died with the last pod." },
        { head: "Find both views of one of your pods", text: "Your app's own metrics endpoint, and the cluster's view of the same container. Know which number comes from where before the day you need to tell them apart." },
      ],
      next: {
        label: "Where to go next, in the order you will need it",
        items: [
          ["The Three Doors", "/start/three-doors/", "the model above, in full, with the failure gallery"],
          ["Sizing Walkthrough", "/tuning/sizing-walkthrough/", "turning a load test into requests, limits and probes"],
          ["The Two Roads", "/start/two-roads/", "the five steps, in full, for the day something breaks"],
          ["The Three Lenses", "/start/three-lenses/", "the three places to stand, for the day something is slow"],
        ],
      },
      notes: "End on something they can do without permission from anyone. All four are read-only or one-line changes, and all four produce a question they will bring back — which is the real goal of the session. The reading order matters: do not send a new engineer to the Lenses first, because they have not yet had the experience that makes it necessary.",
    },
  ],
};
