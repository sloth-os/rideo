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
  the element sheet, reference-sheet requests, E6 staleness, the `elements.*` requirements); dialogue (legacy
  voices, voice readiness per mode, voiced lines and speakers, line seeds, the line layout, V1 readiness, the
  video request's reference audio, sound and length, the `voices.speakingLocked` requirement, V6 staleness, the
  Dialogue track with muted takes and timed captions, cloned real voices and the disclosure rule); storyboard
  (frame states from missing to approved and back when the shot or a lock changes, the `storyboard.approved`
  requirement and progress, the animatic's stills, dialogue and captions, stills looped in the chunk graph and
  skipped by audio, Fountain/FDX parsing and PDF lines rebuilt into Fountain, heading parsing, the import's
  characters and locations, the shot list CSV quoting); directing (lens and aperture fragments, the move phrase
  in videos and the lens in keyframes, `camera_motion` from moves, last frames and reference videos only for
  models that take them, fixed seeds with attempt and variation offsets, legacy shots, frames outdated by a lens
  change); take editing (edit requests with the take as the reference video and the cast references, the five
  edit phrases, extensions from the first frame or into the last frame, legacy takes without lineage);
  multi-shot (groups bounded by shot count and length, continuations and shots with their own request kept
  alone, gaps; detected versus planned split points; one request listing every shot with the cast and elements
  once); post audio (track stems by role and id, `set_track`/`set_mix`, the per-stem buses and stem outputs,
  speech spans in timeline time and their merging, the duck envelope, its breakpoints and its ffmpeg expression
  evaluated against `duckGainAt`, no duck without mix, music or speech, speech spans and the mix written by
  assembly and the auto edit, loudnorm statistics and passes, score cues per scene with short cues merged and
  laid with crossfades, spot and ambience effect placement); localization (word splitting and timing from an
  alignment or by length, `build` and `pop` frames, the same word in `activeAt` and the chunk graph's `drawtext`
  windows, `set_caption_style`, `update_text` dropping words, SRT and WebVTT with word timestamps and escaping, the
  `localizations/<lang>.json` and `renders/<id>.json` documents, the cut's lines and takes, stale translations, dub
  currency with edited lines and relocked voices, subtitled and dubbed variants: translated captions on the
  original or dub timings, dub mixes on the Dialogue track, lip-synced close-ups, `withoutCaptions`).
- **server**: repository commit, log, diff, restore, branches, tags, coalescing and GC on `MemoryBackend`;
  job queue (lanes, priorities, dedupe, retry classification, cancel propagation, restart recovery; the
  `client` lane: claim order, leases, heartbeats, expiry and session release, cancel, staged files);
  consistency gate scoring, preconditions R1/R2, stale detection R6, override rules R8, fail-closed R9; LLM
  adapters' request shapes and JSON repair (and audio parts for the speaker check); live hub sequencing,
  replay and resync; config parsing (TTS and speaker-check endpoints); the ElevenLabs and OpenAI TTS clients
  against a fake proxy (design, save, clone, speech with timings and seeds, retryable failures, metrics); the
  speaker-check merge (V4: same, different, missing and silent voices, no judge, judge outage); sound effects
  through a fake proxy (request shape, length clamp, retryable failures, `rideo_post_audio_total`) and the
  `RIDEO_SFX_*` config; ElevenLabs alignments grouped into words.
- **web**: live-event store reducer and optimistic timeline edits (apply, confirm, roll back), live client
  (sequence dedupe, UI-command acks, restart resync), UI command dispatch, WebCodecs codec/container
  selection, render engine choice, the editor-job worker against a fake API (claims only with a project and a
  session, one job at a time, progress heartbeats, failures reported with their code, cancellations and
  lost leases not reported, claim retry when the claim overtakes the live subscription), timeline edge-drag
  ops, and rendering of the workflow stepper, consistency badge, job rows and take badges (lineage and
  multi-shot segments), and the preview's duck automation (`automateDuck`, the shared breakpoints from any
  playback start). Resuming an interrupted render
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
  mock. Responses are validated against the vendored gateway `openapi.json`. The proxy answers the post-audio
  tasks (`score.plan`, `sfx.plan`), ElevenLabs sound generation and `dialogue.translate`.
- **Story workflow** (`story.test.ts`): REST from brief to export on the mock gateway, including a
  consistency failure and retry (`MOCK_FLAKY_EVERY`), R1 rejection, approval gates, batch to a 60 s target,
  timeline assembly, an export rendered by the reference editor worker, watermark detection of the export,
  and C2PA Content Credentials on every take and on the export (every take and the music as ingredients);
  elements: the screenplay's locations and props become draft elements linked from scenes and planned shots,
  E1 (`element_not_locked`) and E2 (`element_locked`), element lock versions on takes, E6 staleness after a
  relock with changes, E4 judging with `judgeElements`, and the batch stopping for a new prop until it is locked;
  V1 (`voice_not_locked`) before the speaking characters' voices are locked, and the takes' TTS dialogue mixes
  as AI-generated ingredients of the export.
- **Dialogue** (`dialogue.test.ts`): voices against the mock's ElevenLabs endpoints: design three previews, pick
  (the saved voice keeps the preview), lock, V2 (`voice_locked` for design, pick and description), relock keeps
  the version; cloning needs consent; TTS takes (line audio, mix, timings, voice locks, the model conditioned on
  the mix); the lip-sync pass with `mock-video-lite-v1`; native audio with the speaker check passing and failing
  (V4); V1 and V6 (relock with another voice marks takes stale, regeneration speaks with the new voice); the
  Dialogue track and timed captions; dialogue off; a server without TTS (`tts_unavailable`).
- **Directing** (`directing.test.ts`): moves, lens and aperture in the prompts and `camera_motion`, a fixed seed;
  a generated, verified end frame and an image end frame as `last_frame` (dropped for a model without last
  frames); an image start frame and a pose reference video; resource validation; variations with offset seeds
  and continued numbering (the mock records every request it gets).
- **Take editing** (`take-editing.test.ts`): a relit take is a verified, watermarked derived take that keeps the
  sound and dialogue, signed as an AI edit with its parent as ingredient; a new-angle edit; an extension from the
  last frame (+N s, trimmed to what was asked); generative extend after a take (a signed, watermarked extension
  resource inserted in the cut) and before footage (`last_frame`); validation, including a model without last
  frames.
- **Multi-shot** (`multishot.test.ts`): with `mock-multishot-v1`, a three-shot clip renders its first two shots
  in one request (one keyframe, 20 s), split at the detected cut into two verified, watermarked takes with TTS
  dialogue, the third alone; the setting turned off and a shot with an end frame generate shot by shot.
- **Post audio** (`post-audio.test.ts`): an assembled cut ducks under its TTS lines; *score* lays one generated
  cue per scene (the direction reaches the prompt, instrumental requests); *effects* puts one spot per take on the
  Effects track after the Dialogue track through the mock's ElevenLabs sound generation; an export at broadcast
  loudness with stems (−23 LUFS ± 1 measured on the file, true peak ≤ −1 dBTP, three WAV stems as long as the
  film, the music stem's Content Credentials placing the cues, every frame of the cut in the export);
  `sfx_unavailable` and `features.sfx` without a provider. `post-audio-render.test.ts` runs the shared graphs with
  native ffmpeg: the music stem is −12 dB under speech and follows the ramps, the stems sum to the mix, loudness
  normalization to −14 and −23 LUFS keeps the stems summing, silence and `off` are left alone.
- **Localization** (`localization.test.ts`): SRT and WebVTT of the cut (word timestamps from the aligned speech);
  Spanish translated, dubbed with the locked voices and the close-up lip-synced (watermarked, signed); a corrected
  line survives translating again and makes only its take's dub stale and redubbed; a dubbed variant with sidecar
  subtitles (its `renders/<id>.json` has no captions and the dub mixes) and a subtitled one rendered by the
  reference worker; `localization_incomplete` for missing translations or stale dubs.
- **Watermark** (`watermark.test.ts`) also checks that a watermarked video with sound keeps every frame (the mux
  is bounded by the length, not `-shortest`).
- **Storyboard** (`storyboard.test.ts`): the storyboard plans the first scenes and draws a verified frame (and
  dialogue) per shot; approving one and all; the gate; editing a shot makes its frame outdated
  (`board_unapprovable`) and relocking a character makes frames stale until redrawn; reordering keeps the first
  shot a cut; the video pass starts from approved frames and reuses their dialogue (one generation per take); the
  animatic (stills, music, dialogue, captions) rendered by the reference worker with native ffmpeg, watermarked and
  credentialed; the storyboard turned off; the shot list as CSV and as a PDF read back with pdfjs; Fountain, FDX
  and PDF (written with the server's PDF writer) imports.
- **Footage workflow** (`footage.test.ts`): upload with a browser-style probe, an inbox/URL import processed
  by the worker, analysis signals from the worker then AI and rule suggestions, review, auto edit, export.
- **MCP** (`mcp.test.ts`): the official MCP client over Streamable HTTP. Lists tools, runs a production
  through tools (including designing, picking and locking a voice, importing a screenplay and reading the
  storyboard and the shot list), and asserts that a WebSocket subscriber
  received the matching `commit`, `job` and
  `activity` events and that `ui_*` commands reach a fake browser session with acks.
- **WebDAV editing** (`webdav-sync.test.ts`): edit `screenplay.json` through the WebDAV client and sync (a
  commit by `webdav`); an invalid edit raises a `sync-issue`; the inbox import creates resources.
- **Recovery** (`recovery.test.ts`): kill the server mid-generation, restart, and check the job resumes with
  the same gateway idempotency keys.

### End-to-end (Playwright)

Projects: `desktop` (1440×900) runs every spec except `responsive`; `mobile` (412×915, touch) runs
`responsive`, `mcp-sync`, `provenance`, `elements`, `dialogue`, `storyboard`, `directing`, `take-editing`,
`multi-shot`, `post-audio` and `localization`. The
web server stops with SIGTERM so the stack removes its data; stale stack directories older than an hour are removed
when a new stack starts. Specs:

| Spec | Flow |
|---|---|
| `story.spec.ts` | brief → screenplay → cast (generate, approve, lock; design, pick and lock every voice; then the locations and props in the Elements view) → storyboard (generate, approve all frames, approve) → pilot from the approved frames (the speaking take carries TTS dialogue) → approve → batch (30 s target) → approve → editor (assemble; the Dialogue track holds the mixes; split, inspector trim, edge-drag trim; the preview plays local proxies because H.264 is hidden from WebCodecs) → export rendered in the tab (`auto` → ffmpeg.wasm) → verify watermark |
| `mcp-sync.spec.ts` | page open; the test drives MCP tools as “Claude Code” (create character, add reference, lock, `ui_navigate`, `ui_focus`, `ui_notify`) and asserts the page updates live, attributed to the agent, without a reload; an agent's `export_render` is claimed and rendered by the open tab (`auto` → WebCodecs) and watermarked by the server |
| `footage.spec.ts` | upload (probe + poster in the browser) → analysis signals in the browser → AI suggestions → accept → auto edit → exports with the ffmpeg.wasm and WebCodecs engines → both listed and verified |
| `history.spec.ts` | edit → history → diff → restore → UI updates |
| `take-editing.spec.ts` | (desktop and mobile) relight a take and extend another by 2 s from the take tiles (lineage badges); generative extend of the first item in the editor (the lanes on desktop, the item list on phones) |
| `localization.spec.ts` | (desktop and mobile) captions set to word by word; Spanish added with dubbing (the close-up lip-synced); a line corrected in the translations dialog makes its dub stale until *Dub* runs again; the dubbed Spanish variant exported with sidecar subtitles (language badge, VTT download) |
| `post-audio.spec.ts` | (desktop and mobile) the Mix card: ducking on after assembly, depth −18 dB, *Score the cut* with a direction (Cue 1 on the Music track), *Add sound effects* (an Effects track, its lane on desktop); an export rendered in the tab at broadcast loudness with stems; the export card shows about −23 LUFS and the three stem downloads |
| `multi-shot.spec.ts` | (desktop and mobile) the multi-shot setting off and on in the project settings; a clip on `mock-multishot-v1` renders two shots in one request (`shot 1 of 2`, `shot 2 of 2` badges) and the third alone |
| `directing.spec.ts` | (desktop and mobile) the Direct panel sets a push-in, an 85 mm lens, f/2 and a generated end frame; two variations are generated, compared side by side and B is chosen |
| `storyboard.spec.ts` | (desktop and mobile) generate the storyboard, approve a frame, move it later, approve all; download the shot list CSV and PDF; build the animatic, play it, export it in the tab (listed as an animatic export); approve the storyboard; import a Fountain screenplay in the Story view |
| `dialogue.spec.ts` | (desktop and mobile) the Cast view's voice panel: design three voices, the previews play, pick one, lock it; clone a recording of a real person through the consent dialog and lock it; the gate stops asking for voices; the dialogue mode setting |
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
