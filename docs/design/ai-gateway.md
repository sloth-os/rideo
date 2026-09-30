# AI gateway integration

Rideo never talks to an AI provider directly. It has two paths into
[mm-gateway](https://github.com/sloth-os/mm-gateway):

| Traffic | Path | Module |
|---|---|---|
| Image, video, music generation | **`@sloth-os/mm-gateway-js` SDK**: `ImagesApi`, `VideosApi`, `MusicApi`, `MetaApi` | `server/src/gateway/gateway-client.ts` |
| Everything else: LLM text, vision judge, speech-to-text | **Gateway reverse proxy**: `{MM_GATEWAY_URL}/proxy/{domain}/{path}` | `server/src/gateway/proxy-client.ts`, `server/src/ai/*` |

Both use the same gateway bearer key (`MM_GATEWAY_API_KEY`). Upstream credentials stay in the gateway.

## SDK usage

The SDK is an OpenAPI-generated CommonJS package. It is pinned as a git dependency
(`github:sloth-os/mm-gateway-js#<commit>`) and built by its own `prepare` script. `GatewayClient` owns one
`ApiClient` configured with `basePath`, the bearer key, and a timeout:

```ts
const client = new GatewayClient({ baseUrl, apiKey, routingProfile, pollIntervalMs, timeouts });
await client.health();                                   // MetaApi.getHealth
await client.listModelLimits('video');                   // MetaApi.listModelLimits (cached 5 min)
const task = await client.generateImage(req, { idempotencyKey, signal, onUpdate });
const task = await client.generateVideo(req, { idempotencyKey, signal, onUpdate });
const task = await client.generateMusic(req, { idempotencyKey, signal, onUpdate });
```

- Requests are plain objects in the gateway's snake_case wire format (`duration_seconds`,
  `negative_prompt`, …), built by the shared prompt compiler and validated with zod before sending. The
  SDK serializes them unchanged.
- `generate*` = `create*WithHttpInfo` (202 + task) → poll `get*WithHttpInfo` until `status` is terminal,
  honouring `Retry-After`. The result is a normalized `GatewayTask {id, model, status, outputs[], usage, error}`.
- Errors: HTTP problem details (`application/problem+json`) become `GatewayHttpError {status, code, detail}`.
  Failed tasks become `GatewayTaskError {code, message}`. Both carry `retryable` (429 and 5xx, and the task
  codes `timeout`, `rate_limited`, `provider_unavailable`, `upstream_error`).
- `routing.profile` is sent when `MM_GATEWAY_ROUTING_PROFILE` is set. `model` is sent when the project pins
  one; otherwise it is omitted and the gateway auto-routes by limits.
- `metadata` carries `{rideo_project, rideo_job, rideo_step}` for cross-system tracing.
- Outputs arrive as `https://…` or `data:` URIs. `MediaStore.importUri()` downloads, hashes and stores them.

## Proxy usage (LLM, vision, STT)

```ts
const res = await proxy.fetch(domain, path, { method: 'POST', body, headers, signal });
// → fetch(`${MM_GATEWAY_URL}/proxy/${domain}/${path}`, { headers: { authorization: `Bearer ${key}` } })
```

`LlmClient` adapters speak the upstream's native API through the proxy:

| `RIDEO_LLM_PROVIDER` | Default proxy domain | Endpoint | JSON mode | Images |
|---|---|---|---|---|
| `openai` (and any OpenAI-compatible API) | `api.openai.com` | `v1/chat/completions` | `response_format: {type: "json_object"}` | `image_url` data URIs |
| `gemini` | `generativelanguage.googleapis.com` | `v1beta/models/{model}:generateContent` | `generationConfig.responseMimeType: application/json` | `inline_data` |
| `anthropic` | `api.anthropic.com` | `v1/messages` (`anthropic-version: 2023-06-01`) | instructions + prefill `{` | `image` base64 blocks |

Speech-to-text (optional, used by footage analysis): OpenAI-style
`POST /proxy/{RIDEO_STT_PROXY_DOMAIN}/v1/audio/transcriptions` (multipart, `response_format=verbose_json`).
When unset, analysis runs without a transcript.

## Structured tasks

Every LLM use is a **task** with an id, a zod output schema, a system prompt and a user-content builder
(`server/src/ai/tasks.ts`). The first line of every system prompt is a machine-readable marker
(`rideo-task: <id>`), which is also how the mock gateway recognizes the task.

| Task | Input | Output (validated) |
|---|---|---|
| `media.describe` | user images + video keyframes | `{summary, style, setting, people[{label, description, identity}]}` |
| `screenplay.generate` | prompt, attachment descriptions, target/pilot length, language, aspect | `{title, logline, synopsis, genre, tone, style, characters[], outline[], scenes[]}` |
| `screenplay.extend` | story so far (summaries), cast, outline beats to write | `{scenes[]}` |
| `clip.plan` | scene, cast, style, video model limits | `{shots[]}` |
| `character.describe` | one photo | `{identity, summary, wardrobe[]}` |
| `consistency.judge` | references per character, candidate frames | `{frames[{index, characters[{characterId, present, identityScore, outfitScore, issues}]}]}` |
| `footage.analyze` | probe stats, scenes, silences, thumbnails, transcript | `{summary, suggestions[]}` |

`runTask()`:

1. Build messages, call the adapter in JSON mode (temperature 0.7 for writing, 0 for judging).
2. Extract JSON: strip code fences, then take the outermost object.
3. Validate with zod. If validation fails, make **one repair call** with the validation errors and the
   previous output.
4. If it still fails, raise `llm_invalid_output` (retryable at the job level).

Latency, model, token usage (when reported) and the task id are logged per call, and counted in
`rideo_llm_calls_total{task,status}`.

## Mock gateway

`packages/mock-gateway` implements the public mm-gateway contract that Rideo uses. Its responses are
validated against the gateway's `openapi.json` in contract tests. It powers the integration and e2e suites
and the offline demo (`npm run dev:demo`).

| Surface | Behaviour |
|---|---|
| `GET /health`, `/v1/models`, `/v1/models/limits` | `mock-image-v1` (image-to-image, ≤4 input images), `mock-video-v1` (2–10 s, first/last frame, reference images), `mock-music-v1` |
| `POST /v1/images`, `/v1/videos`, `/v1/music` + `GET …/{id}` | Real async lifecycle (`pending → running → succeeded`, `Retry-After`, `Idempotency-Key` replay and 409 on body mismatch, `ETag`/`304`). Produces real media: PNGs (pngjs), H.264 MP4 via ffmpeg (a first frame, when given, is animated with a slow zoom), WAV/MP3 tones. |
| `/proxy/{domain}/{path}` | OpenAI, Gemini and Anthropic request/response shapes. It routes on the `rideo-task:` marker and returns deterministic JSON derived from the input. |
| `POST /proxy/*/v1/audio/transcriptions` | segments sized to the audio duration |

**Deterministic consistency model.** Each character name maps to a *signature colour*. Mock reference sheets
paint that colour into a marker band. Mock keyframes and videos copy the marker bands of the reference
images they receive, as a real model copies identity. The mock judge decodes the PNG frames and checks the
bands. `MOCK_FLAKY_EVERY=n` drops the bands from every n-th generation, so tests can prove that the gate
retries and recovers. `metadata.mock_fail: "<code>"` fails a task with that code.
