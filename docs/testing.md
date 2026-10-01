# Testing

Three layers, all runnable locally and in CI. Tests never call real AI providers. The
[mock gateway](design/ai-gateway.md#mock-gateway) stands in for mm-gateway, including its proxy.

| Layer | Runner | Real processes | Location |
|---|---|---|---|
| Unit | Vitest (node / jsdom) | none (in-memory storage, fake judge, fake clock) | `packages/*/test/unit`, `packages/shared/test` |
| Integration | Vitest (node) | Rideo server, embedded WebDAV, mock gateway, ffmpeg | `packages/server/test/integration`, `packages/mock-gateway/test` |
| End-to-end | Playwright | full stack + built web app in Chromium at desktop and mobile viewports | `e2e/` |

```bash
npm run test:unit
npm run test:integration          # needs ffmpeg/ffprobe on PATH
npx playwright install chromium   # once
npm run test:e2e                  # builds the web app, starts the stack, runs Playwright

# external WebDAV conformance against Apache httpd + mod_dav (Docker)
scripts/webdav/run.sh
RIDEO_TEST_WEBDAV_URL=http://rideo:rideo@localhost:8080/ npx vitest run --project server-integration packages/server/test/integration/storage.test.ts
```

## What each layer proves

### Unit

- **shared**: every zod schema (including rejection cases); timeline reducer (every op, ripple and magnetic
  invariants, invalid ops); `activeAt` for transitions; story assembly; suggestion application; workflow
  evaluator for every requirement; prompt compiler determinism and reference selection under
  `max_input_images`; watermark core (DCT orthonormality, CRC, layout determinism, embed/extract round trip
  on synthetic frames, PSNR ≥ 45 dB, no false positive on unmarked frames); JSON diff; canonical JSON;
  media planners and parsers (probe banners from FFmpeg 4.4 and the 5.1 wasm core, analysis logs including
  the empty ebur128 summary, rule suggestions, chunk planning: frame alignment, transitions kept whole,
  long items split, text/audio shifted into chunk time; per-chunk filtergraphs and the soundtrack graph);
  provenance (consent validation, real-person characters, the disclosure rule for every `label` × real-person
  case, `withDisclosure` over and beyond an hour, the corner `label` drawtext); elements (library merging by
  name and alias, scene and shot linking, element prompt sentences, the element share of the image budget and
  the element sheet, reference-sheet requests, E6 staleness, the `elements.*` requirements).
- **server**: repository commit, log, diff, restore, branches, tags, coalescing and GC on `MemoryBackend`;
  job queue (lanes, priorities, dedupe, retry classification, cancel propagation, restart recovery; the
  `client` lane: claim order, leases, heartbeats, expiry and session release, cancel, staged files);
  consistency gate scoring, preconditions R1/R2, stale detection R6, override rules R8, fail-closed R9; LLM
  adapters' request shapes and JSON repair; live hub sequencing, replay and resync; config parsing.
- **web**: live-event store reducer and optimistic timeline edits (apply, confirm, roll back), live client
  (sequence dedupe, UI-command acks, restart resync), UI command dispatch, WebCodecs codec/container
  selection, render engine choice, the editor-job worker against a fake API (claims only with a project and a
  session, one job at a time, progress heartbeats, failures reported with their code, cancellations and
  lost leases not reported, claim retry when the claim overtakes the live subscription), timeline edge-drag
  ops, and rendering of the workflow stepper, consistency badge and job rows. Resuming an interrupted render
  is covered by the editor-jobs integration test, local proxies by the story e2e spec.

### Integration

- **Storage conformance** (`storage.test.ts`): one suite against `MemoryBackend`, the embedded WebDAV server
  and (optionally) an external server: read/write/stat/list/move/delete, nested MKCOL, streaming, ranges,
  conditional writes when advertised.
- **Render plan** (`render.test.ts`): the shared chunk graphs and soundtrack graph run through native ffmpeg
  (a cut followed by a crossfade; a split and trimmed clip before a wipe, with speed and fades; text) and
  every chunk must have exactly its planned frame count; the concatenated chunks must equal the planned
  length.
- **Editor jobs** (`editor-jobs.test.ts`): the REST protocol with a Node **reference editor worker**
  (`test/helpers/editor-worker.ts`) that implements the browser's jobs with native ffmpeg and the same shared
  planners: claim/lease/heartbeat, staged uploads, resume after a lost lease, cancel, and the follow-up
  jobs.
- **Provenance** (`provenance.test.ts`): the development signer's certificate chain verifies with
  `node:crypto`; a footage export is signed as a C2PA composite of its source, with the policy label burned in
  and recorded, bound to its watermark, and trusted by the C2PA SDK given the dev CA; uploaded likenesses need
  a consent record (`consent_required`); with `RIDEO_API_TOKEN` set, the public detection endpoint accepts
  uploads without the token (reduced response, size cap) while `{uri}` and every other route still need it.
- **Watermark robustness** (`watermark.test.ts`): embed into an ffmpeg-generated textured clip, then detect
  after x264 CRF 23 and 28, VP9, a 2 s trim, a metadata strip, and a downscale/upscale. Assert no detection
  on the unmarked source.
- **SDK contract** (`mock-gateway/test/contract.test.ts`): the real `@sloth-os/mm-gateway-js` SDK against the
  mock. Responses are validated against the vendored gateway `openapi.json`.
- **Story workflow** (`story.test.ts`): REST from brief to export on the mock gateway, including a
  consistency failure and retry (`MOCK_FLAKY_EVERY`), R1 rejection, approval gates, batch to a 60 s target,
  timeline assembly, an export rendered by the reference editor worker, watermark detection of the export,
  and C2PA Content Credentials on every take and on the export (every take and the music as ingredients);
  elements: the screenplay's locations and props become draft elements linked from scenes and planned shots,
  E1 (`element_not_locked`) and E2 (`element_locked`), element lock versions on takes, E6 staleness after a
  relock with changes, E4 judging with `judgeElements`, and the batch stopping for a new prop until it is locked.
- **Footage workflow** (`footage.test.ts`): upload with a browser-style probe, an inbox/URL import processed
  by the worker, analysis signals from the worker then AI and rule suggestions, review, auto edit, export.
- **MCP** (`mcp.test.ts`): the official MCP client over Streamable HTTP. Lists tools, runs a production
  through tools, and asserts that a WebSocket subscriber received the matching `commit`, `job` and
  `activity` events and that `ui_*` commands reach a fake browser session with acks.
- **WebDAV editing** (`webdav-sync.test.ts`): edit `screenplay.json` through the WebDAV client and sync (a
  commit by `webdav`); an invalid edit raises a `sync-issue`; the inbox import creates resources.
- **Recovery** (`recovery.test.ts`): kill the server mid-generation, restart, and check the job resumes with
  the same gateway idempotency keys.

### End-to-end (Playwright)

Projects: `desktop` (1440×900) runs every spec except `responsive`; `mobile` (412×915, touch) runs
`responsive`, `mcp-sync`, `provenance` and `elements`. Specs:

| Spec | Flow |
|---|---|
| `story.spec.ts` | brief → screenplay → cast (generate, approve, lock; then the locations and props in the Elements view) → pilot → approve → batch (30 s target) → approve → editor (assemble, split, inspector trim, edge-drag trim; the preview plays local proxies because H.264 is hidden from WebCodecs) → export rendered in the tab (`auto` → ffmpeg.wasm) → verify watermark |
| `mcp-sync.spec.ts` | page open; the test drives MCP tools as “Claude Code” (create character, add reference, lock, `ui_navigate`, `ui_focus`, `ui_notify`) and asserts the page updates live, attributed to the agent, without a reload; an agent's `export_render` is claimed and rendered by the open tab (`auto` → WebCodecs) and watermarked by the server |
| `footage.spec.ts` | upload (probe + poster in the browser) → analysis signals in the browser → AI suggestions → accept → auto edit → exports with the ffmpeg.wasm and WebCodecs engines → both listed and verified |
| `history.spec.ts` | edit → history → diff → restore → UI updates |
| `elements.spec.ts` | (desktop and mobile) the screenplay's location in the Elements view → generate, approve, lock; add a prop and link it to a scene in the Story view |
| `provenance.spec.ts` | (desktop and mobile) uploading a likeness opens the consent dialog; a real person needs subject, grantor and date and marks the character; the disclosure setting labels the export; the export card and the public Verify page show the Content Credentials |
| `responsive.spec.ts` | every main view on mobile: no horizontal overflow, navigation reachable, primary actions visible |

The e2e stack starts through Playwright's `webServer`: mock gateway, Rideo server with the embedded
WebDAV (temporary data dir), and the built web app served by the Rideo server. Tiny media sizes (320×180)
and short durations keep the suite fast. Playwright's Chromium decodes H.264 with WebCodecs, so the story
spec emulates a browser without an H.264 decoder (an init script hides AVC from `VideoDecoder`): the preview
must play through local proxies and `auto` must pick the ffmpeg.wasm engine. The footage spec renders with
both engines explicitly, and the MCP spec checks that `auto` picks WebCodecs when every source decodes.

## CI (`.github/workflows/ci.yml`)

| Job | Runs |
|---|---|
| `lint` | Biome + `tsc --noEmit` for every package |
| `unit` | unit suites with coverage |
| `integration` | integration suites (ffmpeg installed via apt) |
| `webdav-compat` | storage conformance against Apache httpd 2.4 + `mod_dav` (`scripts/webdav/run.sh`) |
| `e2e` | Playwright desktop + mobile; traces and screenshots uploaded on failure |
| `docker` | builds the production image (pushed to GHCR on `main`) |
