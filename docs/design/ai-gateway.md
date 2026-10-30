# AI gateway integration

Rideo never talks to an AI provider directly. It has two paths into
[mm-gateway](https://github.com/sloth-os/mm-gateway):

| Traffic | Path | Module |
|---|---|---|
| Image, video, music generation | **`@sloth-os/mm-gateway-ts` SDK**: `ImagesApi`, `VideosApi`, `MusicApi`, `MetaApi` | `server/src/gateway/gateway-client.ts` |
| Everything else: LLM text, vision judge, speech-to-text | **Gateway reverse proxy**: `{MM_GATEWAY_URL}/proxy/{domain}/{path}` | `server/src/gateway/proxy-client.ts`, `server/src/ai/*` |

Both use the gateway bearer key (`MM_GATEWAY_API_KEY`), except that proxies the studio registered itself are called
with the studio's own gateway key (below). Upstream credentials always stay in the gateway: either its operator
configured them, or an administrator typed an API key in Settings and Rideo registered it as a proxy account through
the gateway's management API ([provider endpoints and API keys](settings.md#provider-endpoints-and-api-keys)). No
request Rideo sends carries an upstream credential. The gateway's URL, keys, routing profile and models are set in
Settings or the environment ([settings](settings.md)).

## Without a gateway

`MM_GATEWAY_URL` has no default. Without it `GatewayClient` and `ProxyClient` refuse every call with
`gateway_not_configured` at once (no connection attempt, no timeout), the optional endpoints (speech-to-text,
embeddings, voices, sound effects, the speaker check) are not configured, and `JOB_GATEWAY`
(`shared/src/schemas/job.ts`) decides per job kind: `required` kinds are refused when queued, `optional` ones do
less (footage analysis keeps its rule-based suggestions, thumbnails are evenly spaced, reframing keeps the subject
centered, enhancement uses ffmpeg), `none` never call the gateway. See
[settings](settings.md#without-mm-gateway).

## SDK usage

The SDK is [`@sloth-os/mm-gateway-ts`](https://github.com/sloth-os/mm-gateway-ts), generated from the gateway's OpenAPI
contract by `typescript-axios`: typed requests and tasks, one class per API, CommonJS with declarations. It is pinned as a
git dependency (`github:sloth-os/mm-gateway-ts#<commit>`) and built by its own `prepare` script. `GatewayClient` owns one
`Configuration` (the gateway URL as `basePath`, the bearer key as `accessToken`) and one axios instance (a 120 s timeout,
the `User-Agent`, a direct connection like the proxy client's `fetch`) shared by `ImagesApi`, `VideosApi`, `MusicApi` and
`MetaApi`:

```ts
const client = new GatewayClient({ url, apiKey, routingProfile, pollMs, timeoutsSec, metrics, log });
await client.health();                                   // MetaApi.getHealth
await client.modelLimits('video');                       // MetaApi.listModelLimits (cached 5 min)
const task = await client.generateImage(req, { idempotencyKey, signal, metadata, onTask });
const task = await client.generateVideo(req, { idempotencyKey, signal, metadata, onTask });
const task = await client.generateMusic(req, { idempotencyKey, signal, metadata, onTask });
```

- Requests are plain objects in the gateway's snake_case wire format (`duration_seconds`,
  `negative_prompt`, …), built by the shared prompt compiler. Their types in `@rideo/shared`
  (`GatewayImageRequest`, `GatewayVideoRequest`, `GatewayMusicRequest`) are checked against the SDK's generated
  `ImageRequest`, `VideoRequest` and `MusicRequest` when the server compiles, so a part role or a parameter the
  contract does not have fails the typecheck rather than a gateway `422`.
- `generate*` = `create*` (202 + task, `Idempotency-Key`) → poll `get*` until `status` is terminal,
  honouring `Retry-After`. Outputs are downloaded from the provider's URLs with up to three tries (a dropped
  connection, a `5xx` or a `429` from the file host); a download that still fails is a retryable `gateway_error`,
  so the job runs again instead of failing after the generation was paid for. The job's `AbortSignal` goes with every request: cancelling a job aborts the request in
  flight. The result is a normalized `GatewayTask {id, model, status, outputs[], usage, error}`, validated with zod.
- **A busy provider.** A `429` to `create*` says the provider is at its rate or concurrency limit and made no task:
  the call waits and asks again with the same `Idempotency-Key` (mm-gateway stores a key only with a created task),
  15 s, then doubling up to 60 s with jitter, or longer when the answer's `Retry-After` asks, for up to 10 minutes
  in all; each wait counts as `rideo_gateway_tasks_total{status="busy"}` and is logged (`the provider is busy;
  waiting to create the task`). The job keeps its lane slot while it waits, as the provider's limit is the real one.
  The ctaigw aggregator of the October 2026 demos limits Wan 3.0's concurrent tasks (`model_concurrency_limit`): with
  seven shots of the swimming pilot at once, four were turned away, and one failed all three runs of its job, 2 s and
  4 s apart.
- Errors: an HTTP problem (`application/problem+json`) becomes `GatewayHttpError {status, code, detail}`, no
  response at all (refused, reset, timed out) a `GatewayHttpError` without a status. Failed tasks become
  `GatewayTaskError {code, message}`. Both carry `retryable` (no response, 429 and 5xx, and the task codes
  `timeout`, `rate_limited`, `provider_unavailable`, `upstream_error`, `provider_timeout`, `internal_error`).
- **A refused output.** A provider's moderation sometimes refuses what it generated, not what it was asked: on the
  real-model CI run of October 28 Volcengine refused a cartoon panda's reference sheet with `400
  OutputImageSensitiveContentDetected`, and the job failed at once. A job's retry could not help: mm-gateway answers a
  reused `Idempotency-Key` with the task it stored, failed or not. So a task that fails with an output refusal
  (`OutputImageSensitiveContent`, `OutputVideoSensitiveContent`, "output … may contain sensitive/inappropriate …") is
  asked for again at once as a new task (`<key>:refused<n>`), with a different seed when the request pins one, up to
  two more times; each counts as `rideo_gateway_tasks_total{status="refused"}` and is logged (`the provider refused
  its own output; asking again`). A third refusal fails as `output_refused`, which the job does not retry. A refused
  input (the prompt or a reference image) is not asked again: it would be refused the same way.
- `routing.profile` is sent when `MM_GATEWAY_ROUTING_PROFILE` is set. `model` is sent when the project pins
  one; otherwise it is omitted and the gateway auto-routes by limits.
- Image and video requests ask for no visible watermark (`parameters.watermark: false` unless the request says
  otherwise): Rideo marks its own output ([provider watermarks](provenance.md#provider-watermarks)).
- `metadata` carries `{rideo_project, rideo_job, rideo_step}` for cross-system tracing.
- `enhance_prompt` (the provider's own prompt rewriting, Wan's `prompt_extend`) is sent only when
  `settings.generation.enhancePrompt` is set ([continuity](continuity.md#prompts-version-2)).
- Every finished task adds its output (images, seconds) and cost (`usage.cost` when the gateway reports one, else the
  price table) to the current job's usage, and to `rideo_gateway_task_seconds` and `rideo_gateway_usage_total`.
- Outputs arrive as `https://…` or `data:` URIs. `MediaStore.importUri()` downloads, hashes and stores them.

## Proxy usage (LLM, vision, STT, embeddings)

```ts
const res = await proxy.fetch(api, path, { method: 'POST', body, headers, signal });
// api = { domain, prefix } from the endpoint's API base URL (parseApiBase)
// → fetch(`${MM_GATEWAY_URL}/proxy/${api.domain}/${withPrefix(path, api.prefix)}`,
//         { headers: { authorization: `Bearer ${keyFor(api.domain)}` } })
```

`path` is the adapter's path with its API version (`v1/chat/completions`, `v1beta/models/…`); a base URL with a path
replaces that first segment (`https://ark.cn-beijing.volces.com/api/v3` → `api/v3/chat/completions`), a bare domain or a
URL without a path keeps it ([API base URL](settings.md#api-base-url)). `keyFor(domain)` is the studio's own gateway key
for the domains whose proxy it registered, else `MM_GATEWAY_API_KEY`. A call to a domain whose registration is still
running waits for it.

### Proxies registered by the studio

When API keys are set in Settings, `GatewayProxies` (`server/src/gateway/proxy-sync.ts`) keeps the gateway's proxies
in step with them through the SDK's `ManagementApi` (`getManagementConfig`, `putManagementProxy`,
`deleteManagementProxy`, `putManagementKey`, `deleteManagementKey`, each with the revision in `If-Match`; a `412`
re-reads and re-plans, three times at most). The plan is a pure function of the gateway's (redacted) configuration and
the desired proxies, so it is unit-tested without a gateway; what it creates, keeps and removes is in
[registration in mm-gateway](settings.md#registration-in-mm-gateway). The management calls use the admin token
(`MM_GATEWAY_ADMIN_KEY`, else the gateway key), a 15 s timeout and a direct connection, and are never retried in a
loop: a failure is reported on the Settings page and retried at the next start, save or endpoint test.

`LlmClient` adapters speak the upstream's native API through the proxy:

| `RIDEO_LLM_PROVIDER` | Default proxy domain | Endpoint | JSON mode | Images | Video with sound (`omni`) |
|---|---|---|---|---|---|
| `openai` (and any OpenAI-compatible API) | `api.openai.com` | `v1/chat/completions` | `response_format: {type: "json_object"}` | `image_url` data URIs | `video_url` data URIs (`data:video/mp4;base64,…`) with `modalities: ["text"]`, as Qwen-Omni takes them |
| `gemini` | `generativelanguage.googleapis.com` | `v1beta/models/{model}:generateContent` | `generationConfig.responseMimeType: application/json` | `inline_data` | `inline_data` (`video/mp4`) |
| `anthropic` | `api.anthropic.com` | `v1/messages` (`anthropic-version: 2023-06-01`) | instructions + prefill `{` | `image` base64 blocks | – |

The **audio-visual model** (`omni`, [settings](settings.md)) is a model that watches a video and hears its sound in
one call (`qwen3.8-omni-flash` through an OpenAI-compatible API, Gemini). Videos go inline, encoded small: H.264 with
mono AAC, at most 7 MB (Qwen-Omni takes base64 under 10 MB). A five-second take at 360p is about 1,300 input tokens.
Calls with video are metered as `vision`. Rideo asks it what is heard (`sound.check`, `feedback.listen`) and leaves
the picture to the vision model: watching a long scene as one video, it reported cuts and jumps that no frame shows
([how a film is watched](feedback.md#how-a-film-is-watched)).

**Long calls.** OpenAI-compatible calls are streamed (`stream: true`, `stream_options: {include_usage: true}`; the
answer is the concatenated `delta.content` of the events, the usage comes with the last one). The upstream sends its
headers at once and tokens as they come, so no timeout that waits for headers ends a long answer: neither
mm-gateway's (600 s per read, including the wait for the headers) nor the HTTP client's (undici's 300 s). Writing the
outline and opening scenes of a ten-minute film took more than ten minutes through an overloaded proxy (October 2026
demo), and both cut it off. `RIDEO_LLM_TIMEOUT_SEC` (default 600 s) is how long a call may go without receiving
anything (the first byte, then between events); a streamed answer may take four times that in all. An upstream that
refuses `stream` (a 400 naming it) is asked again without it, and an answer that is not an event stream is read as
JSON. Gemini calls are streamed the same way (`streamGenerateContent?alt=sse`: the parts of every event joined, the
usage of the last; an upstream that answers `404` or `405` there is asked `generateContent` from then on), and so are
Anthropic calls (`stream: true`: the `text_delta`s joined, the input tokens of `message_start`, the output tokens of
`message_delta`; a 400 naming `stream` is asked again without it). An error event in any stream is a retryable
`llm_error`; keep-alives and lines that are not JSON are skipped. The proxy client opens
its connections without header or body timeouts of their own, so a call's timeout is the only one. A connection that
fails or a call that times out is a retryable `llm_error`: the job runs again (up to its `maxAttempts`). Other
proxied calls keep their own timeouts (speech-to-text 600 s, voices 120–300 s, embeddings 60 s).

Speech-to-text (optional, used by footage analysis): OpenAI-style
`POST /proxy/{RIDEO_STT_PROXY_DOMAIN}/v1/audio/transcriptions` (multipart, `response_format=verbose_json`,
`timestamp_granularities[]` `word` and `segment`: the words' timings drive transcript editing,
[editor](editor.md#transcript-editing)). When unset, analysis runs without a transcript.

Embeddings (optional, used by [media search](search.md)): OpenAI-style `POST /proxy/{RIDEO_EMBEDDINGS_PROXY_DOMAIN}/v1/embeddings`
`{model, input: string[]}` in batches of 64, validated and put back in input order. When unset, search ranks by words.

### Reasoning

Checks and captions, made for every attempt of every shot, answer without reasoning
(`REASONING_OFF_TASKS`: `consistency.judge`, `sound.check`, `voice.judge`, `frame.caption`): OpenAI-compatible calls
send `enable_thinking: false` (Qwen's switch), Gemini calls `thinkingConfig.thinkingBudget: 0`; Anthropic models do
not reason unless asked. An upstream that refuses the field (a 400 naming it) is asked again without it, and that
adapter never sends it again (the same for every optional field). Writing, planning and feedback keep the model's
reasoning. Measured on 16 frames of the panda demo through the same proxy (12 that had passed, 4 with a human girl, a
stand-in panda or a cast member who should not be there), `qwen3.8-max` judged the same pass or fail for every frame
with and without reasoning and caught all four bad ones; without it a call took 8.6 s instead of 57.1 s (median) and
wrote 231 tokens instead of 2,304. Its scores run higher without reasoning (identity mostly 0.95–1.0 instead of
0.85–0.9), so a threshold near the top would separate less. `RIDEO_CHECK_REASONING=model` keeps the model's default.

### Refusals

A provider's moderation sometimes refuses a harmless answer (`data_inspection_failed`, "output data may
contain inappropriate content", or a `content_filter` finish): DashScope ended a footage analysis of a test pattern
that way. A refused call is made once more at temperature 0; a second refusal fails as `llm_refused` (not retried by
the job). Both count as `rideo_llm_calls_total{status="refused"}`.

### Outages

The newapi proxy of the October 2026 demos answered `503 system cpu overloaded` to every model for long stretches.
Each job kept trying on its own: four calls per run of a task, and three runs 2 s and 4 s apart, so a writing job
failed within a minute (a failed `clip.plan` skipped its scene, a failed `screenplay.extend` stopped the batch).
Rideo now pauses an endpoint that keeps failing and lets its jobs wait for it:

| Rule | Value |
|---|---|
| Endpoint | the proxy domain and the model (`newapi.example.org/qwen3.8-max`): one overloaded model does not pause the others |
| A failure | a call turned away for load (`429`, `500`, `502`, `503`, `529`), a timeout or a connection that failed; any other answer (even a `400`) counts as answered |
| Paused | after 6 failures in a row, for `RIDEO_LLM_PAUSE_SEC` (30 s; 0 turns pausing off), doubling after every failure that follows a pause, up to 5 min |
| While paused | calls are not made: the call fails at once as a retryable `llm_error` that says so ("…/qwen3.8-max is paused after 6 failed calls in a row; next try in 25 s") |
| After a pause | the endpoint takes calls again; the first answer ends the outage (logged `LLM endpoint answering again`), the first failure pauses it again for twice as long. No call waits for a probe, so a long streamed answer holds nobody up |
| Jobs | a job that failed on a paused endpoint is queued again for when the pause ends, and that run does not count against its `maxAttempts`; after an hour of pauses in a row it does, so a dead endpoint still fails its jobs. The jobs panel shows why a job waits |
| Checks | a judge or sound check on a paused endpoint fails at once, so the take stays unverified and the video lane goes on; the batch judges unverified takes again at its end ([re-checking](character-consistency.md#re-checking-unverified-takes)) |

Any job retry also waits as long as the provider's last `Retry-After` asked (up to 10 min) when that is longer than
its own backoff. `rideo_llm_paused{endpoint}` is 1 from an endpoint's first pause until it answers again, `rideo_llm_pauses_total{endpoint}`
counts the pauses and `rideo_llm_calls_total{status="paused"}` the calls not made.

**Fallbacks.** A pause only waits. When the swimming film's scene reviews ran on October 28 the newapi proxy answered
`502` to the judge and the listener alike: both endpoints paused, two of five fixed takes stayed unverified and did
not count as fixed. Each family of calls may have a fallback endpoint on another provider (Settings: *Text model,
fallback*, *Vision, fallback*, *Audio-visual model, fallback*; [endpoints](settings.md#endpoints)):

| Family | Its calls | Fallback |
|---|---|---|
| writing | text tasks (the text model) | `llmFallback` |
| judging | tasks with images (vision) | `visionFallback` (its provider and base URL come from the text fallback when left empty) |
| listening | tasks with video and sound (the audio-visual model) | `omniFallback` (likewise from the vision fallback; a model is required) |

A call goes to its family's fallback when its endpoint is paused, or when the endpoint turned it away for load or
failed to answer after its own retries; the fallback has a pause of its own. When both are paused the call fails as
before and the job waits. A task whose first answer was invalid is repaired on the endpoint that gave it. Calls the
fallback takes count as `rideo_llm_fallbacks_total{task}` and are logged (`LLM call sent to the fallback endpoint`);
the job's usage names the model that answered.

## Enhancement

Upscaling and frame interpolation of exports ([finishing](finishing.md#enhancement-upscale-and-frame-interpolation))
are video requests through the SDK to a model whose limits say `supports_upscale` /
`supports_frame_interpolation` (`max_fps`): the rendered part as a `reference_video`, the delivery's `dimensions`
and `fps`. Without such a model Rideo uses ffmpeg and says so on the export.

## Segmentation

*Remove the background* ([editor](editor.md#segmentation-masks-remove-the-background)) is a video request through the
SDK to a model whose limits say `supports_segmentation` (`settings.models.segment`, `auto` picks the first): the
item's source range as a `reference_video` and a prompt naming the subject; the model returns a matte of the same
frames. Without such a model the request fails with `segmentation_unavailable`.

## Performance

Performance takes ([performance](performance.md)) are video requests through the SDK to a model whose limits say
`supports_performance` (`settings.models.performance`, `auto` picks the first): the shot's first frame as
`first_frame`, the performance (normalized to H.264 and AAC, trimmed to the shot) as `reference_video`, and the shot's
prompt with the performance phrase. Without such a model they fail with `performance_unavailable`.

## Sound effects

Sound effects ([post audio](post-audio.md#effects-from-action-lines)) are not a gateway media modality, so they go
through the proxy like speech: ElevenLabs sound generation,
`POST /proxy/{RIDEO_SFX_PROXY_DOMAIN}/v1/sound-generation?output_format=mp3_44100_128`
`{text, duration_seconds (0.5–22), prompt_influence: 0.4, model_id}` → MP3 (`server/src/ai/sfx.ts`). Outcomes are
counted in `rideo_post_audio_total{op="sfx"}`; failures are `gateway_error` (retryable on 429 and 5xx).

## Structured tasks

Every LLM use is a **task** with an id, a zod output schema, a system prompt and a user-content builder
(`server/src/ai/tasks.ts`). The first line of every system prompt is a machine-readable marker
(`rideo-task: <id>`), which is also how the mock gateway recognizes the task.

| Task | Input | Output (validated) |
|---|---|---|
| `media.describe` | user images + video keyframes | `{summary, style, setting, people[{label, description, identity}]}` |
| `screenplay.generate` | prompt, attachment descriptions, target/pilot length, language, aspect | `{title, logline, synopsis, genre, tone, style, characters[], locations[], props[], outline[], scenes[]}` (scenes name their `location` and `props`) |
| `screenplay.extend` | story so far (summaries), cast, outline beats to write | `{scenes[]}` |
| `clip.plan` | scene (with its location and props), cast, style, video model limits | `{shots[]}` (each with the `props` visible in it) |
| `character.describe` | one photo | `{identity, summary, wardrobe[]}` |
| `consistency.judge` | references per character (and per element when `judgeElements`), the scene reference frame (quality checks), candidate frames | `{frames[{index, characters[{characterId, present, identityScore, outfitScore, issues}], elements?[{elementId, present, score, issues}], physics?{score, issues}, continuity?{score, issues}}]}` ([quality checks](continuity.md#quality-checks-in-the-gate)) |
| `footage.analyze` | probe stats, scenes, silences, thumbnails, transcript | `{summary, suggestions[]}` |
| `score.plan` | the film (title, genre, tone, style), the direction, the cues (length, scene, dialogue or not) | `{cues[{index, prompt, bpm?}]}` ([post audio](post-audio.md)) |
| `reframe.focus` | three frames of a take, its shot and cast | `{frames[{index, x, y}]}` (the subject's centre, [finishing](finishing.md#auto-reframe-and-cut-downs)) |
| `thumbnail.pick` | candidate frames of an export, the title, how many | `{picks[{index, reason}]}` best first |
| `dialogue.translate` | the target language, the film (title, logline, tone), the cast names, the scene and its lines | `{lines[{key, text}]}` ([localization](localization.md#translation)) |
| `sfx.plan` | the takes of the cut (length, description, action, location), `maxPerShot` | `{effects[{shot, description, at, durationSec, kind}]}` |
| `frame.caption` | one frame (512 px wide), what it is from, who and what its source shows (with how they look), the cast | `{caption}` (≤ 300 characters, [search](search.md#the-index)) |
| `sound.check` | the shot (description, action, its lines with each speaker's voice), the cast's voices, whether takes may carry music, and the take as a video with its sound (360p) | `{speech[{text, speaker, voice, lipSync?}], music, sounds[], score, issues[]}` ([quality checks](continuity.md#quality-checks-in-the-gate)) |
| `feedback.scene` | the film, one scene with its neighbours, the cast, every shot with its take's reports, the signals inside the scene, a strip of three frames per shot | `{scores{dimension: 0–10}, summary, strengths[], issues[{shot, dimension, severity, title, detail, at}], recommendations[{shot?, dimension, priority, title, detail, action?}]}` ([feedback](feedback.md#how-a-film-is-watched)) |
| `feedback.listen` | the same input, and the scene as a video with its sound (the audio-visual model) | `{scores{dialogue, sound}, summary, issues[{shot?, time?, dimension, …}], recommendations[…], transcript[{time, speaker, text}]}`, dialogue and sound only |
| `feedback.film` | the project (logline, synopsis, outline), every scene's scores, summary and issues, the signals, the run's numbers | `{scores, summary, strengths[], recommendations[{dimension, priority, title, detail, scenes[], action?}], lessons[{area, title, detail}]}` |

`runTask()`:

1. Build messages, call the adapter in JSON mode (temperature 0.7 for writing, 0 for judging). A call the provider
   turns away for load (`429`, `500`, `502`, `503`, `529`, or a dropped connection) is made again up to 3 times,
   waiting 2 s, 4 s, then 8 s, with jitter, or longer when the answer's `Retry-After` asks (up to 60 s). Timeouts,
   `504`, other answers, and mm-gateway's own problems that are not about load (`provider_not_configured`,
   `forbidden`, …; its `rate_limited`, `provider_unavailable`, `upstream_error`, `generation_service_error` (its 502
   when the proxied API fails) and `internal_error` are) are not
   repeated here; a timeout or a connection that failed otherwise becomes a retryable `llm_error`, so the job runs
   again. Each retry is logged (`LLM call turned away; retrying`, with the
   task, status and wait) and counted in `rideo_llm_retries_total{task,status}`; a judge that still fails leaves the
   take unverified (R9). While an endpoint is [paused](#outages) the call is not made at all.
2. Extract JSON: strip code fences, then take the outermost object. Schemas are lenient where models drift: the
   judge's verdicts may name a character instead of giving its id, and stray strings in its lists are dropped.
3. Validate with zod. If validation fails, make **one repair call** with the validation errors and the
   previous output.
4. If it still fails, raise `llm_invalid_output` (retryable at the job level).

Latency, model, token usage (when reported) and the task id are logged per call, and counted in
`rideo_llm_calls_total{task,status}`, `rideo_llm_call_seconds{task,model}` and `rideo_llm_tokens_total{task,model,direction}`;
inside a job they are added to its usage ([observability](observability.md#usage-ledger)). With prompt version 2,
`screenplay.generate`, `screenplay.extend` and `clip.plan` get the dialogue level and the continuity inputs of
[continuity](continuity.md).

## Mock gateway

`packages/mock-gateway` implements the public mm-gateway contract that Rideo uses. Its responses are
validated against the gateway's `openapi.json` in contract tests. It powers the integration and e2e suites
and the offline demo (`npm run dev:demo`).

| Surface | Behaviour |
|---|---|
| `GET /health`, `/v1/models`, `/v1/models/limits` | `mock-image-v1` (image-to-image, ≤4 input images), `mock-video-v1` (2–10 s, first/last frame, reference images, audio and video), `mock-video-lite-v1` (no last frame, no reference audio or video), `mock-multishot-v1` (`max_shots: 4`, 2–20 s; [multi-shot](multi-shot.md)), `mock-wan3-v1` (Wan 3.0's limits: 2–30 s, `max_shots: 8`, frames exclusive with references, no negative prompt), `mock-enhance-v1` (upscale and frame interpolation of a reference video; [finishing](finishing.md)), `mock-segment-v1` (`supports_segmentation`: an ellipse matte of the reference video; [editor](editor.md#segmentation-masks-remove-the-background)), `mock-lipsync-v1`, `mock-music-v1` |
| `POST /v1/images`, `/v1/videos`, `/v1/music` + `GET …/{id}` | Real async lifecycle (`pending → running → succeeded`, `Retry-After`, `Idempotency-Key` replay and 409 on body mismatch, `ETag`/`304`). Produces real media: PNGs (pngjs), H.264 MP4 via ffmpeg (a first frame, when given, is animated with a slow zoom), WAV/MP3 tones. |
| `/proxy/{domain}/{path}` | OpenAI, Gemini and Anthropic request/response shapes. It routes on the `rideo-task:` marker and returns deterministic JSON derived from the input (`settings.test` answers `OK`). `GET …/models` lists the mock's models. A domain registered through the management API is served like the real gateway: only to keys its tags allow (`403` otherwise), with the first account's id in `x-mm-gateway-proxy-account`; other domains are open, or refused with `404` with `MOCK_GATEWAY_STRICT_PROXIES=1`. |
| `/v1/management/config`, `/v1/management/proxies/{domain}`, `/v1/management/keys/{id}` | The management subset Rideo uses, behind `MOCK_GATEWAY_MANAGEMENT_KEY`: the redacted configuration with its revision (`ETag`), proxies and keys created, replaced and deleted with `If-Match` (`428` without, `412` when stale), `[redacted]` values kept from the stored ones. Tests read the stored credentials from `gw.management`. |
| `POST /proxy/*/v1/audio/transcriptions` | segments sized to the audio duration (every other line with filler words) and their word timings (`words`) |
| `POST /proxy/*/v1/sound-generation` | a pink-noise burst of `duration_seconds` (MP3) |

**Deterministic consistency model.** Each character name maps to a *signature colour*. Mock reference sheets
paint that colour into a marker band. Mock keyframes and videos copy the marker bands of the reference
images they receive, as a real model copies identity. The mock judge decodes the PNG frames and checks the
bands. `MOCK_FLAKY_EVERY=n` drops the bands from every n-th generation, so tests can prove that the gate
retries and recovers. `overloadChat(n)` makes the next n chat calls through the proxy answer
`503 system cpu overloaded`, as an overloaded upstream does, so tests can prove that LLM calls are made again.
`holdChat(marker)` holds every chat call that mentions the marker (a task's `rideo-task: <id>` line) until its
`release()`, as a model still answering does, and `held()` counts the calls it holds, so tests can change documents
while a review is waiting for its model. `metadata.mock_fail: "<code>"` fails a task with that code. `refuseOutputs(n)` fails the next n image or video tasks as a provider's moderation refusing its output does (`provider_error`, `OutputImageSensitiveContentDetected`).
