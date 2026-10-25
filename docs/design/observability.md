# Observability

What it costs, how long it takes, how good it is and how it feels to use: a studio that makes films out of hundreds
of paid generations needs all four answered from data, per project and for the whole studio. Rideo answers them with
structured **logs**, Prometheus **metrics**, a **usage ledger** per project, the **insights** page and **telemetry**
from the studio in the browser. [Feedback](feedback.md) adds the quality of the finished film and the retrospective of
each project.

## Logs

JSON (pino). Every line of a request carries `reqId`; every line of a job carries `jobId`, `projectId` and `kind`;
gateway calls carry the gateway task id; exports, feedback and editor jobs add their ids. Errors carry their stable
`code` ([errors](../api/rest.md)). A request that takes longer than 2 s logs `slow request` with its route, status,
time and the storage operations it made (count and time), so a per-request storage lookup shows in the logs rather
than in a demo.

## Usage ledger

Every gateway task and every language, vision and speech call is **usage**, attributed to the job that made it. The
job queue runs each handler inside an async context (`AsyncLocalStorage`) holding the job's usage; `GatewayClient`
and `LlmTasks` add to whatever usage is current, so no handler passes it along. Calls outside a job (a search query,
a settings test) are counted under the studio only.

```ts
type Usage = {
  llmCalls: number; llmRetries: number; tokensIn: number; tokensOut: number;
  images: number; videoSeconds: number; videoCount: number; musicSeconds: number; ttsCharacters: number;
  costUsd: number;          // what is priced
  unpriced: number;         // usage items without a price
  discardedVideoSeconds: number; discardedCostUsd: number;   // attempts the gate threw away
  byModel: Record<string, { modality: 'text' | 'vision' | 'image' | 'video' | 'music' | 'speech';
                            calls: number; seconds: number; units: number; costUsd: number }>;
};
```

- **The job** keeps its own usage (`job.usage`, in its record).
- **The project** keeps the sum in `.rideo/usage.json` beside the job records: totals, `byKind` (jobs, outcomes, run
  and queue seconds, cost) and `byModel`. It is written behind the jobs (at most every 5 s, one write at a time) and
  read when the project loads; a missing or broken file starts again from zero.
- **The studio** counts it in metrics (below).

**Prices.** A gateway task that reports its cost (`usage.cost`, from the provider or the gateway's estimate) is
counted at that cost. Otherwise the price table `RIDEO_PRICES` (Settings → Limits; JSON, per model id) prices it:

```json
{ "doubao-seedream-5.0-pro": { "image": 0.03 },
  "wan3.0-video-prime": { "videoSecond": 0.1 },
  "qwen3.8-max": { "inputMTokens": 0.8, "outputMTokens": 3.2 } }
```

Keys: `image`, `videoSecond`, `musicSecond`, `request`, `inputMTokens`, `outputMTokens`, `character`. Usage of a model
without a price is counted (seconds, images, tokens) and marked unpriced, never guessed.

**Waste.** A video attempt that fails the gate and is not the take that is kept counts as discarded (its seconds and
cost), as does a take replaced by a regeneration: the cost of quality, which the retrospective reports.

## Metrics

`GET /metrics` (Prometheus text format, behind the studio's authentication).

| Metric | Type | Labels | What |
|---|---|---|---|
| `rideo_jobs_total` | counter | `kind`, `status` | jobs finished |
| `rideo_job_duration_seconds` | histogram | `kind` | run time |
| `rideo_job_wait_seconds` | histogram | `kind` | from queued to the first start (lane wait) |
| `rideo_lane_jobs` | gauge | `lane`, `state` (`running`, `waiting`) | jobs per lane now |
| `rideo_gateway_tasks_total` | counter | `modality`, `status` | gateway tasks |
| `rideo_gateway_task_seconds` | histogram | `modality`, `model` | create to terminal |
| `rideo_gateway_usage_total` | counter | `modality`, `model`, `unit` (`images`, `video_seconds`, `music_seconds`) | generated output |
| `rideo_llm_calls_total` | counter | `task`, `status` | structured tasks |
| `rideo_llm_call_seconds` | histogram | `task`, `model` | one task, repairs and retries included |
| `rideo_llm_tokens_total` | counter | `task`, `model`, `direction` (`in`, `out`) | tokens reported by the provider |
| `rideo_llm_retries_total` | counter | `task`, `status` | calls made again after 429/5xx |
| `rideo_cost_usd_total` | counter | `modality`, `model` | estimated cost of priced usage |
| `rideo_usage_unpriced_total` | counter | `modality`, `model` | usage items without a price |
| `rideo_shot_step_seconds` | histogram | `step` (`keyframe`, `video`, `verify`) | where a shot's time goes: the keyframe with its judge calls, the video task and its download, the checks |
| `rideo_take_attempts` | histogram | `stage` (`keyframe`, `video`) | attempts until a take passed (or ran out) |
| `rideo_consistency_checks_total` | counter | `result` | identity gate outcomes |
| `rideo_consistency_score` | histogram | – | judge scores of video attempts |
| `rideo_quality_checks_total` | counter | `check` (`temporal`, `physics`, `sound`), `result` | [quality checks](continuity.md#quality-checks-in-the-gate) |
| `rideo_feedback_total` | counter | `outcome` | [feedback](feedback.md) runs |
| `rideo_feedback_score` | histogram | `dimension` | film scores 0–10 |
| `rideo_feedback_recommendations_total` | counter | `action`, `outcome` | applied and dismissed recommendations |
| `rideo_http_request_seconds` | histogram | `method`, `route` (the route pattern), `status` (class: `2xx`…) | REST latency |
| `rideo_storage_seconds` | histogram | `op` | WebDAV operations, buckets up to 300 s (uploads to slow cloud drives) |
| `rideo_storage_ops_per_request` | histogram | – | storage operations one request made |
| `rideo_web_vitals_seconds` | histogram | `metric` (`lcp`, `fcp`, `ttfb`, `inp`) | page experience in the studio |
| `rideo_web_cls` | histogram | – | layout shift |
| `rideo_web_timing_seconds` | histogram | `op` (`project_load`, `editor_ready`, `first_frame`, `export_chunk`) | studio operations people wait for |
| `rideo_web_errors_total` | counter | `kind` (`error`, `rejection`, `api`) | errors in the studio |

The metrics that were already there (watermark, storage retries, work tree, live sessions, accounts, push, search,
brand, recipes, performance, masks, interchange, review, editor jobs, commits, C2PA, dialogue, storyboard, voices,
finishing, localization, post audio, settings, workspaces, project files) keep their names; each design page lists
its own.

## Insights

`GET /api/projects/:id/insights` (MCP `project_insights`) answers what the project's run looked like, from the usage
ledger, the job records of the last seven days and the documents:

```ts
type Insights = {
  usage: ProjectUsage;                                   // the ledger
  jobs: { kind: string; count: number; succeeded: number; failed: number; cancelled: number;
          p50Sec: number | null; p90Sec: number | null; waitP50Sec: number | null; errors: Record<string, number> }[];
  takes: { total: number; passed: number; failed: number; unverified: number; overridden: number;
           firstTry: number; qualityFailed: number; meanAttempts: number | null };
  characters: { characterId: string; name: string; checks: number; failures: number }[];
  stages: { stage: string; at: string }[];               // gate approvals, in order
  feedback: { exportId: string; createdAt: string; overall: number | null;
              scores: Record<string, number | null> }[];  // newest first
  retrospective: Feedback['retrospective'];              // of the newest feedback
};
```

The **Insights** view of a project (next to History) shows it in four cards: **Cost** (estimated total, per minute of
film, by model and by job kind, waste, unpriced usage), **Time** (per job kind: median and slowest runs, queue waits,
failures with their errors), **Quality** (first-try pass rate, attempts, unverified and overridden takes, quality
failures, the characters who fail most, feedback scores across exports) and **Improvements** (the newest
retrospective). It is a projection of data the studio already has: no new documents, refreshed when jobs end.

## Telemetry from the studio

The studio sends what only the browser knows to `POST /api/telemetry`
`{events: [{kind: 'vital' | 'timing' | 'error', name, value, route?}]}` (at most 50 events per request, validated,
names from fixed lists, no content of projects or people): Core Web Vitals (`PerformanceObserver`: LCP, FCP, TTFB,
CLS, and the slowest interaction as INP), timings of the waits people notice (a project's first load, the editor
ready, the first decoded frame, each export chunk) and error counts (uncaught errors, rejected promises, API errors by
status class). Events are batched and sent every 15 s and when the page is hidden (`fetch` with `keepalive`). They
become the `rideo_web_*` metrics and, at debug level, log lines. `RIDEO_TELEMETRY=off` turns the endpoint (404) and
the client off.

## What to watch

| Question | Where |
|---|---|
| Is the studio slow for people? | `rideo_http_request_seconds`, `rideo_web_vitals_seconds`, `rideo_web_timing_seconds`, slow-request logs |
| Where does a film's time go? | Insights → Time; `rideo_shot_step_seconds`, `rideo_job_wait_seconds`, `rideo_lane_jobs` |
| What does a film cost, and what is wasted? | Insights → Cost; `rideo_cost_usd_total`, `rideo_gateway_usage_total`, waste in the ledger |
| Is quality getting better? | Insights → Quality; `rideo_take_attempts`, `rideo_consistency_score`, `rideo_quality_checks_total`, `rideo_feedback_score` |
| Is a provider struggling? | `rideo_llm_retries_total`, `rideo_gateway_tasks_total{status}`, `rideo_gateway_task_seconds` |
| What should change next time? | the retrospective of each project's feedback, and [improvements](../improvements.md) |
