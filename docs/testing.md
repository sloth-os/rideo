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
  on synthetic frames, PSNR ≥ 45 dB, no false positive on unmarked frames); JSON diff; canonical JSON.
- **server**: repository commit, log, diff, restore, branches, tags, coalescing and GC on `MemoryBackend`;
  job queue (lanes, priorities, dedupe, retry classification, cancel propagation, restart recovery);
  consistency gate scoring, preconditions R1/R2, stale detection R6, override rules R8, fail-closed R9; LLM
  adapters' request shapes and JSON repair; render planner filtergraphs; live hub sequencing, replay and
  resync; config parsing.
- **web**: live-event store reducer, live client (sequence dedupe, UI-command acks, restart resync), UI
  command dispatch, WebCodecs codec/container selection, timeline edge-drag ops, and rendering of the
  workflow stepper, consistency badge and job rows.

### Integration

- **Storage conformance** (`storage.test.ts`): one suite against `MemoryBackend`, the embedded WebDAV server
  and (optionally) an external server: read/write/stat/list/move/delete, nested MKCOL, streaming, ranges,
  conditional writes when advertised.
- **Server render** (`render.test.ts`): generated filtergraphs run through real ffmpeg (a cut followed by a
  crossfade; a split and trimmed clip before a wipe, with speed and fades) and must produce exactly the
  planned number of frames.
- **Watermark robustness** (`watermark.test.ts`): embed into an ffmpeg-generated textured clip, then detect
  after x264 CRF 23 and 28, VP9, a 2 s trim, a metadata strip, and a downscale/upscale. Assert no detection
  on the unmarked source.
- **SDK contract** (`mock-gateway/test/contract.test.ts`): the real `@sloth-os/mm-gateway-js` SDK against the
  mock. Responses are validated against the vendored gateway `openapi.json`.
- **Story workflow** (`story.test.ts`): REST from brief to export on the mock gateway, including a
  consistency failure and retry (`MOCK_FLAKY_EVERY`), R1 rejection, approval gates, batch to a 60 s target,
  timeline assembly, server render, watermark detection of the export.
- **Footage workflow** (`footage.test.ts`): upload, analysis (rule-based and AI suggestions), review, auto
  edit, render.
- **MCP** (`mcp.test.ts`): the official MCP client over Streamable HTTP. Lists tools, runs a production
  through tools, and asserts that a WebSocket subscriber received the matching `commit`, `job` and
  `activity` events and that `ui_*` commands reach a fake browser session with acks.
- **WebDAV editing** (`webdav-sync.test.ts`): edit `screenplay.json` through the WebDAV client and sync (a
  commit by `webdav`); an invalid edit raises a `sync-issue`; the inbox import creates resources.
- **Recovery** (`recovery.test.ts`): kill the server mid-generation, restart, and check the job resumes with
  the same gateway idempotency keys.

### End-to-end (Playwright)

Projects: `desktop` (1440×900) runs every spec except `responsive`; `mobile` (412×915, touch) runs
`responsive` and `mcp-sync`. Specs:

| Spec | Flow |
|---|---|
| `story.spec.ts` | brief → screenplay → cast (generate, approve, lock) → pilot → approve → batch (30 s target) → approve → editor (assemble, split, inspector trim, edge-drag trim) → server export → verify watermark |
| `mcp-sync.spec.ts` | page open; the test drives MCP tools as “Claude Code” (create character, add reference, lock, `ui_navigate`, `ui_focus`, `ui_notify`) and asserts the page updates live, attributed to the agent, without a reload |
| `footage.spec.ts` | upload → analysis → accept suggestions → auto edit → timeline → browser export with WebCodecs → export listed |
| `history.spec.ts` | edit → history → diff → restore → UI updates |
| `responsive.spec.ts` | every main view on mobile: no horizontal overflow, navigation reachable, primary actions visible |

The e2e stack starts through Playwright's `webServer`: mock gateway, Rideo server with the embedded
WebDAV (temporary data dir), and the built web app served by the Rideo server. Tiny media sizes (320×180)
and short durations keep the suite fast.

## CI (`.github/workflows/ci.yml`)

| Job | Runs |
|---|---|
| `lint` | Biome + `tsc --noEmit` for every package |
| `unit` | unit suites with coverage |
| `integration` | integration suites (ffmpeg installed via apt) |
| `webdav-compat` | storage conformance against Apache httpd 2.4 + `mod_dav` (`scripts/webdav/run.sh`) |
| `e2e` | Playwright desktop + mobile; traces and screenshots uploaded on failure |
| `docker` | builds the production image (pushed to GHCR on `main`) |
