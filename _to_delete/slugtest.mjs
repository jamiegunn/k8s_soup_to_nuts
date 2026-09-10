import GithubSlugger from 'github-slugger';
const s = new GithubSlugger();
for (const h of ['Exposure discipline: enabled ≠ exposed ≠ reachable','Who owns what','The classic: "-Xmx fits, container still dies"','Phase 5 — productionize the feedback loop','Custom / external metrics (Prometheus adapter, KEDA)',"6. Histograms for the four timers you'll quantile",'Cause 1: CPU throttling — the #1, and the one your graphs hide','JVM heap vs pod memory — the delta','The dead-man\'s switch: absent()']) console.log(JSON.stringify(h), '->', s.slug(h));
