# Testing

Three layers, all runnable locally and in CI, never call a real AI provider: the
[mock gateway](design/ai-gateway.md#mock-gateway) stands in for mm-gateway, including its proxy. A fourth, the
[real-model suite](#real-models-e2ereal), runs the studio against a real mm-gateway and real image, video and vision
models.

| Layer | Runner | Real processes | Location |
|---|---|---|---|
| Unit | Vitest (node / jsdom) | none (in-memory storage, fake judge, fake clock) | `packages/*/test/unit`, `packages/shared/test`, `e2e/real/*.test.ts` |
| Integration | Vitest (node) | Rideo server, embedded WebDAV, mock gateway, ffmpeg | `packages/server/test/integration`, `packages/mock-gateway/test` |
| End-to-end | Playwright | full stack + built web app in Chromium at desktop and mobile viewports | `e2e/` |
| Real models | Playwright | a studio, mm-gateway (Docker) and the providers behind it, Chromium at the desktop viewport | `e2e/real/` |

```bash
npm run test:unit
npm run test:integration          # needs ffmpeg/ffprobe on PATH
npx playwright install chromium   # once
npm run test:e2e                  # builds the web app, starts the stack, runs Playwright
npm run test:e2e:real             # the real-model suite: needs the variables below and Docker

# external WebDAV conformance against Apache httpd + mod_dav (Docker)
scripts/webdav/run.sh
RIDEO_TEST_WEBDAV_URL=http://rideo:rideo@localhost:8080/ npx vitest run --project server-integration packages/server/test/integration/storage.test.ts
```

## What each layer proves

### Unit

- **shared**: every zod schema (including rejection cases); timeline reducer (every op, ripple and magnetic
  invariants, invalid ops); `activeAt` for transitions; story assembly (the project's names the writer is told,
  `existingNames`: one-line entries within their bounds, none for a new project; the writer's merge keeping the ids,
  seeds, references, locks, library links, 3D pins and locked voices of the entities it matches); suggestion
  application; workflow evaluator for every requirement; prompt compiler determinism and reference selection under
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
  original or dub timings, dub mixes on the Dialogue track, lip-synced close-ups, `withoutCaptions`); finishing
  (presets and explicit options, delivery sizes by short side and the draft cap, crop sizes, focus interpolation,
  the crop window clamped to the frame, the ffmpeg crop expression evaluated against `cropWindow` at any speed,
  reframed timelines and their chunk graph, cut-downs with fades, thumbnail candidates); accounts (the permission
  table and role order, project roles for members, studio visibility, admins and open projects, agent tokens
  capped by role and projects, route permissions); review (mentions by full name, unique first name or email,
  outcomes from each person's latest decision, what a review shows, share-link tokens, drawings, route
  permissions); interchange (timecode, media locations, the picture on frames with the transition handles, OTIO
  tracks, clips, transitions, time warps, notes and titles, OTIO round trip to the same cut, a foreign OTIO with
  handles, gaps, extra tracks, unknown media and speed limits, FCPXML, XML and EDL output); editor depth (keyframe
  interpolation and ffmpeg expressions, overlay opacity with fades, ramp time maps against the exact integral,
  transcript words with punctuation and standalone fillers, `.cube` parsing and the trilinear lookup, overlay tracks,
  ramps, splits and `remove_ranges` in the reducer, overlay layers and sound in the queries, the chunk graph with a
  LUT, an inverted matte, keyframed position and fades as `sendcmd` commands, and ramps); editing tools
  (`editing-tools.test.ts`: markers kept in order and moved by an intro, every op refused on a locked track and caption
  styles skipping it, hidden tracks in the queries and the render plan, moves between tracks, duplicates, freeze frames
  on the primary and free tracks with their graph, detached audio, mirror and key with their graph, the color tables,
  hue matrix and vignette, xfade's dip weights, slides, the circle and its 16-stop gradient, the wipe's edge, snap
  targets, spans and edit points, a freeze and the new transitions in EDL, XML, FCPXML and back from OTIO).
- **shared, continuity and feedback** (`continuity.test.ts`, `feedback.test.ts`): version 1 prompts byte-identical to
  before; version 2 keyframe and video prompts (the scene line, the continuation, compact identities, voices in the
  same words every time, `No dialogue.`, the music line, physics, exclusions in the text and a negative prompt cut at
  500 characters, determinism); the scene reference image in the budget; `fitDialogue` (a shot lengthened within the
  model, lines moved to a continuous shot, nothing cut); the dialogue levels; the quality verdicts (lowest physics,
  mean continuity, temporal jumps, candidates ranked); feedback assembly (issue times from the render timeline and the
  position in the shot, stable ids, recommendations ordered, scores falling back to the duration-weighted scenes,
  `sound` from the signals, the overall weights), unexpected cuts from scene changes against the cut points, framing
  runs and rushed lines, the Markdown report; listening: `dialogueDelivery` (each utterance counted for the shot whose
  lines it matches best), issues placed by their time in the scene, the `dialogue` and heard `sound` scores, a
  regenerate recommendation for a shot whose line was not heard; the sound check (`soundVerdict`: words not spelling,
  a heard word for one line only, the wrong voice, stray speech, music, lips out of sync, merged into the verdict, an
  answer given as a list); the cast in frame (an extra fails the frame, other figures are reported, `absentCast`);
  who is in frame (`inFrameLine` in keyframe, video and multi-shot prompts, left out of the board hash).
- **shared, settings and project files** (`settings-theme.test.ts`, `settings-endpoints.test.ts`, `bundle.test.ts`):
  the settings table (each setting once, in a known group, environment-only configuration and key material kept out,
  secrets marked, `showIf` targets, option labels for every option); the endpoint table (every endpoint's settings
  exist in its group, API keys are secrets, fallbacks point earlier), API base URLs (bare domains, URLs with and
  without a path, ports, refused credentials, queries and schemes), proxy paths with a prefix, credential headers per
  provider, keys shared by origin, desired proxies (one account per key, header names merged, a second origin on one
  domain refused); themes (CSS values that cannot break out, mode colors over shared ones, a readable text color
  for any accent, the brand tokens' WCAG contrast, merging); ustar headers (long names in the prefix, base-256 sizes,
  checksums), the entries a project file carries and the unsafe ones it refuses, the manifest, and the history
  rewrite of a copy (every commit names the new id, other documents and subtrees shared, merges kept).
- **server**: repository commit, log, diff, restore, branches, tags, coalescing and GC on `MemoryBackend`; the work
  tree's external edits (a listing that leaves out a file deletes nothing, a confirmed deletion does); on a store where
  every operation takes a while (`repo.test.ts`), a commit's objects written together and the ref after them, the
  commit answering before the work tree is written, coalescing commits reading the tags once and the tip from memory,
  a burst of commits written to the work tree once per path with the newest version, a failed batch tried again
  (counted and logged), and a commit whose batch was lost written when the project loads while a file edited outside
  Rideo keeps its edit; project existence (`registry.test.ts`): looked up once, a 404 looked at twice, a folder
  deleted outside Rideo noticed by sync's `verify`, a project kept in a browser asked every time; the WebDAV backend
  against a scripted flaky server (`webdav.test.ts`, `test/helpers/flaky-dav.ts`): `423`, `5xx` and dropped
  connections tried again (counted by op and reason), giving up after the retries with a log line, a conditional write
  or a stream repeated only when not applied, `Retry-After` honoured, a false 404 tried again for a file it wrote and
  believed for one it never saw or deleted, one MKCOL per folder level for concurrent writes; job records written one
  at a time with the latest state last;
  job queue (lanes, priorities, dedupe, retry classification, cancel propagation, restart recovery; the
  `client` lane: claim order, leases, heartbeats, expiry and session release, cancel, staged files);
  consistency gate scoring, preconditions R1/R2, stale detection R6, override rules R8, fail-closed R9; LLM
  adapters' request shapes and JSON repair (and audio parts for the speaker check, video parts for the audio-visual
  model); the writer's prompts of both versions reading `existing` and keeping its names (`writer-names.test.ts`);
  streamed chat completions (deltas joined, the usage of the last event, a refused `stream` asked again
  without it but an "upstream" error not, a stream gone quiet ended by the timeout, a streamed error retryable); the
  proxy client waiting for slow headers only as long as the call's timeout and still sending multipart uploads; LLM
  calls made again while the provider turns them away for load (`503`, `429` with its `Retry-After`, a dropped
  connection, mm-gateway's `upstream_error` and `generation_service_error`), giving up after the retries, never for
  `400`, `504` or mm-gateway's `provider_not_configured`, a
  timeout or failed connection made a retryable `llm_error` for the job, and a cancelled job not waiting; live hub sequencing, replay and resync, and job heartbeats on the live channel (leased, lost, cancelled); config parsing (TTS, speaker-check and audio-visual endpoints); the vision judge told who is absent and counting
only those names as extras, and reading verdicts that name a character instead of its id with strays dropped
(`judge.test.ts`); gateway output downloads made again after a dropped connection or a `5xx`, then a retryable
`gateway_error`, and a `404` failing at once (`media-download.test.ts`); the ElevenLabs and OpenAI TTS clients
  against a fake proxy (design, save, clone, speech with timings and seeds, retryable failures, metrics); the
  speaker-check merge (V4: same, different, missing and silent voices, no judge, judge outage); sound effects
  through a fake proxy (request shape, length clamp, retryable failures, `rideo_post_audio_total`) and the
  `RIDEO_SFX_*` config; ElevenLabs alignments grouped into words; finishing (enhancement planning by model
  capabilities, `max_fps`, `off` and pinned models; the finishing filter for models and ffmpeg; the delivery
  encoders; ustar archives with long names and checksums); accounts (the PKCE authorization request, RS256 and ES256
  ID tokens and every rejection: signature, issuer, audience, expiry, issue time, nonce, malformed, an unknown key
  read again from the JWKS; sessions by hash across a restart and their expiry; the audit log's filters; cookies and
  safe return paths; an MCP tool reached without a caller refused outside auth mode `none` while a recipe still runs it,
  `mcp-principal.test.ts`); recipes and the studio library (`recipes.test.ts`: a recipe that names `library_save`,
  `library_update`, `library_apply` or `library_detach` refused when it is saved, naming the step and the tool, the
  library's read tools kept; one saved before the rule refused when a run starts, with no job queued, and its job
  refused before any step runs); notifications (per person, newest first, pushed to that person's tabs only, read
  marks across a restart, the last 500); interchange (the default WebDAV root, embedded or external; review notes on
  takes as markers); the web's sign-in page; FCPXML and XML parsed as XML with awkward titles and labels; the
  inspector's transform keyframes and ramp presets, the transcript panel's filler and selection cuts, waveform
  drawing, and the compositor's overlay placement, opacity, matte alpha and LUT (a recording canvas); the
  Recipes card (built-in and studio recipes, the run dialog's parameters typed); brand text in the compositor
  (two lines, the brand font and box, no box) and the editor's lower third and intro; recipes (parameters, placeholders,
  the built-ins, the tools recipes may not use and no built-in using one); brand kits (font signatures, the bug's
  corner and size, `withBrand` over the other tracks for the whole film, titles and lower thirds in the brand's
  fonts, colors and box, intros that move the other tracks,
  `drawtext` with the brand font and box); search (the frames sampled from takes, footage and stills, what is
  indexed with whom it shows, index runs that drop, copy and caption, names as single terms, BM25 and cosine
  ranking with the best frame per file, names first, the REST query); the Search view (the index's state, indexing,
  kinds, the video at the matched frame, *Show*) and the overlay picker's search (a match from a second before it);
  performance requests (the first frame and the performance for its length, the phrase, rendered alone) and the
  performance recorder (countdown, the stop at the shot's length, the recording's length on the upload, the shot's
  performance set, the camera released, a blocked camera); the engine (threads of ffmpeg.wasm commands, WebGPU
  geometry against the canvas transform, uniforms, half-float LUT texels, the compositor choice, proxy plans,
  the worker ticker, the job lock and wake lock, heartbeats on the ticker, heartbeats sent by a worker with the
  latest progress and a lost lease stopping the job); the installable app (the service
  worker's strategies, pushed messages opening only the app's links, the manifest and its icons, the Inbox's
  approvals, reviews, jobs and agents with approve and cancel); Web Push messages (RFC 8291 Appendix A byte for
  byte, round trips with fresh keys, VAPID tokens that verify).
- **server, settings, storage and subpaths** (`config.test.ts`, `settings.test.ts`, `proxy-sync.test.ts`,
  `browser-storage.test.ts`, `base-path.test.ts`): the settings file merged under the environment (empty variables
  unset), rules across settings reported on the setting to fix, `auto` storage resolution, base paths from the public
  URL, endpoints from API base URLs with their keys (own, shared by origin, the vision and speaker-check fallbacks); the
  settings file (settings only, mode 0600, a broken file ignored) and the service (administrators only, never agent
  tokens, masked secrets, locks); the proxy-sync plan (create, a no-op when nothing changed, a new key replacing the
  old account, other accounts and headers sent back as `[redacted]`, its own proxy moved to a new origin, conflicts at
  another URL or turned off, removal of what is no longer wanted, the studio's key created, rewritten and deleted)
  and the sync against the mock
  gateway's management API and a server without one (`412` re-planned, `401`, `404` and no answer reported with their
  codes, the metric, the identity file's mode, and the key each domain is called with); `FsBackend` (atomic writes, ranges, conditional writes, refused escapes); the workspace registry
  and `RoutedStorage` with stand-in tabs (studio data in the data directory, a new project in the asking browser,
  listings per caller, the trash beside the project, another person's workspace refused, a closed tab failing its
  operations, a reconnecting tab waited for, preconditions passed through); prefix stripping for both proxy styles,
  `X-Forwarded-Prefix` that cannot name another host, the page's `<base>`.
- **web**: live-event store reducer and optimistic timeline edits (queued, the rest replayed on each answer, a
  refused edit dropped and one that no longer applies skipped, live timeline commits held back while edits are
  pending, a reload keeping the shown timeline), live client
  (sequence dedupe, UI-command acks, restart resync, job heartbeats sent when open and their answers handed on), UI
  command dispatch, the limited media fetch (`media-fetch.test.ts`: at most its limit at once, a slot handed on when a
  body ends, fails, is cancelled or aborted, a waiting request dropped when aborted), lane media read only once a block
  comes on screen (`editor-depth.test.tsx`), WebCodecs codec/container
  selection, render engine choice, the editor-job worker against a fake API (claims only with a project and a
  session, one job at a time, progress heartbeats, heartbeats on the live channel too and a job stopped when the live
  channel says it is lost or cancelled, failures reported with their code, cancellations and lost leases not reported,
  claim retry when the claim overtakes the live subscription, one page heartbeat in flight at a time), timeline
  edge-drag
  ops, and rendering of the workflow stepper, consistency badge, job rows and take badges (lineage and
  multi-shot segments), dialogs (Escape closes the one on top only; a render leaves the focus in the field typed
  in), and the preview's duck automation (`automateDuck`, the shared breakpoints from any
  playback start); editing tools (`editing-tools.test.ts`: the edit history's stacks, the keymap and its labels, paste,
  split targets, nudges, drops and a freeze's edges; `compositor.test.ts`: mirror, adjustments and key per pixel, the
  wipe's side, dips over white with xfade's weights from whole frames, slides, the circle's gradient, dips and circles
  handed to the canvas while WebGPU gets the rest; `engine-performance.test.ts`: scissors of wipes and slides,
  mirrored UVs and the uniforms of adjustments, key and vignette, and the thread budget counting every scaler so a
  command stays in ffmpeg.wasm's pool, reading the 118 inputs of a long cut's soundtrack on the main thread); the
  direct panel sending only the camera fields that changed (`direct-panel.test.tsx`: a lens then an aperture changed
  before the store hears of the first keep both). Resuming an interrupted render
  is covered by the editor-jobs integration test, local proxies by the story e2e spec.
- **documents from before the 3D-Editor's desk** (`packages/shared/test/legacy-desk.test.ts`): a clip and a project
  stored with rideo's own desk (`clip.blocking`, `settings.blocking`) still parse and lose those fields, and stored
  storyboard reviews whose issues and recommendations name the `blocking` dimension still parse while no reviewer is
  asked for it ([what happened to the blocking](design/director-desk.md#what-happened-to-the-blocking)).
- **the 3D-Editor's desk** (`packages/shared/test/desk-protocol.test.ts`, `desk-brief.test.ts`, `desk-result.test.ts`,
  `shot-update.test.ts`, `packages/server/test/unit/batch-boards.test.ts`, `desk-precondition.test.ts`,
  `packages/web/test/desk-bridge.test.ts`, `desk-panel.test.tsx`, `desk-results.test.ts`): the protocol's schemas
  against a verbatim copy of the 3D-Editor's fixtures (`packages/shared/test/fixtures/desk-protocol/`: every valid one
  parses, each invalid one is refused but `state-units-bad-staged.json`, a state read with its units unknown), a result
  over its limits, and the desk page's URL rule; the brief from rideo's
  documents, row by row (odd sizes, interiors, the time of day, heights in every form it reads, feet and inches before
  a weight, the order and limits of the cast and elements, layouts filtered to the shot's own cast, a clip without
  shots, clip ids such as `constructor`); a result's plan (the mode each shot carries, of several the one last attached,
  else the first in the protocol's order, every refusal, a shot listed twice, a clip that is not MP4, a length or format
  the desk changed told apart from a shot or project changed in rideo since the brief, a shot the brief retimed told
  apart from a length changed in the desk by the shot's own `brief_length` issue, `changes.retimed` only for a shot
  without one (a stale list after Update shots), a still dropped for its signature or size, the summary naming the modes
  attached, the shot's PATCH parsed to only the lens and the move); a partial camera in the shot update schema left
  without defaults; the production batch storyboarding a passed scene whose frames are outdated; a desk state write's
  precondition evaluated as RFC 9110 does (`If-Match` by strong comparison, with a list and `*`, and `If-None-Match`)
  and the conflict's message (the stored `ETag` or the clear, never "newer"); the bridge with fake windows and ports
  (the handshake, the 15-second timeout after a `load` no `hello` answered and after the desk loads again, `open` with a
  copy of the stored state and again after a second `hello`, a stored state that cannot be loaded failing the panel with
  Retry and Start over and nothing stored, `bad_message`, states stored on Close, before a result, at most every 10
  minutes (from the last write, a state that comes during one too) and when the panel goes away, each write naming the
  state it replaces (`If-Match`, `If-None-Match: *`), a stored state kept after `state_unreadable` or a `412` until the
  person replaces it (the notice chosen by the stored `ETag`, the desk's message a sentence of its own, one toast across
  a desk page that loads again, a desk that sent no state asked for it with `save` and its late answer stored at once,
  the Replace marked as one), a Close held open by a `412` its last write or a write on its way met, a `412` naming a
  state this tab sent taken as the stored one and tried once (a lost answer, a panel that opened again while the last
  one's write was uploading, even one sent after its load) but kept as a conflict once the tab saw the server move past
  that state (another session restored it after this tab's own later write, a `412`, or a later panel's load or Start
  over found another; one whose write went unanswered, once an answer named another state than the one that write
  replaces; a state whose write was refused is never the tab's own, its bytes stored elsewhere before Replace or after),
  a failing write tried again with a backoff and one toast, the same bytes not stored again with the real sha256 against
  the `ETag`, Close not waiting for a result and at most 10 seconds for the write, `result-ack`, a result applied with
  its connection's brief and retimed shots, the desk's errors as toasts only when meant for the person, desk text cut to
  300 characters); the panel (`desk-panel.test.tsx`: no Follow menu of its own, `open`'s modes and the mode last
  attached in the project, the store's precondition, Replace header and `AbortSignal` reaching `fetch`, a `412` made a
  conflict, a result applied with the brief and retimed shots it was given (the shot's own issue over a stale retimed
  list) and its mode remembered, the bridge flushed when the panel goes away, the iframe mounted anew for another clip,
  Replace (three confirmations) and Start over only after their confirmations); a result uploaded and attached shot by
  shot with its JPEG poster ([director's desk](design/director-desk.md#tests)).
- **the studio library** (`packages/shared/test/library.test.ts`, `accounts.test.ts`, `digest.test.ts`,
  `documents.test.ts`, `packages/server/test/unit/library-store.test.ts`, `library-upload.test.ts`): the schemas of
  every kind and their limits; the snapshot digest blind to reference ids, wardrobe ids, `createdAt` and
  `consent.recordedAt` and changed by identity, wardrobe text, reference hashes, seed and pin; snapshots keeping only
  approved references, with consent records, seeds, wardrobe ids and the 3D pin; the apply plan (create keeping the
  item's id and seed above every version the project recorded, locked or not, and counting the takes it makes stale,
  `conflict` for a taken id or name, an alias that is another element's alias or name only warned, update relocking by
  the identity hash, outfits keeping the target's ids (by id, then by name, each once), stale takes and approved clips
  needing `project.approve` for a create as for an update, the locked refusals, 3D items onto their kinds of target
  only, `replacePin: false` refused by a pin and by an update or link whose version carries one, no edit made here
  counted for a pin or a voice the apply keeps, resources always created, archived items refused); `libraryAllows` for
  people, admins, the studio token and agent tokens with and without projects; a digest with and without `library`,
  still version 1; documents without `library` and `deskUnit` still parsing, and a pin changing no identity hash; the
  store on memory and file backends (versions written once, a leftover manifest skipped, two versions at once, heads
  read once and read again after a read that failed, the same bytes stored once) and the service on in-memory storage
  (`unchanged`, `412` `library_conflict` for a stale `If-Match` and a stale `basedOn`, archive, a head it cannot read
  answered with a retryable `storage_error`, a save with `newItem` making a new item whatever `itemId` names,
  permissions through real principals, pins and detach (counted under the item's kind), an approved clip's update
  planned for an editor, refused to them and done by a director, and so a Use in project of a character used again whose
  old take an approved clip holds) and its uploads (`meta` first, a unit of 32 MiB + 1 byte refused with `413`, a unit
  whose prefix, header or kind is wrong, thumbnails that are not PNG, over 64 KiB or over 256 px, a client gone in the
  middle of a part leaving no temporary file, a raster picture known by its signature and an SVG or a page not taken for
  one) ([the library](design/library.md#tests)).
- **library units** (`packages/shared/test/desk-protocol.test.ts`, `desk-brief.test.ts`, `desk-units.test.ts`,
  `packages/web/test/desk-bridge.test.ts`): the new fixtures (valid ones parse, invalid ones refused but
  `state-units-bad-staged.json`, a state read with its units unknown) and the capability read leniently; the brief
  unchanged byte for byte without units and, with them, the set from the scene's location, props, figures with their
  kind and height, only the kinds the desk announced; `X-Desk-State-Units` formatted and parsed, and `state.units` that
  name a slot twice read as not known and sent as no header (the state stored all the same); `deskUnitDrift` for every
  status (a slot made local stays `local` whatever its pin becomes); the bridge sending no unit field to a desk without
  the capability, `open.units` in slot order without the pins the stored state uses (2 fetches at a time, sha256
  checked, never past 48 MiB), `unit-publish` saved, linked by the contract's rule and acknowledged with the mapped
  codes, one at a time, one it cannot read refused `invalid` at once ([library units](design/director-desk.md#tests)).
- **reviews of every step** (`packages/shared/test/ai-review-gates.test.ts`): the whole-take watch's verdict and its
  merge into the quality checks, the scene review's verdict, the clip gate, the cast review's subject and merge
  (fixes pointed at the character), the `cast.reviewPassed` gate (off for older projects, continue anyway), the cut's
  subject, a production scene's storyboard review state.

- **the studio library's pages** (`library-ui.test.tsx`): the library and 3D rows' texts (available, edited here, none,
  a pin the studio lacks), an apply's plan in words (lock versions, stale takes, the approval warning and who may
  confirm), refusals in words by their code, tags, the loop of "Use v3 in all N projects" (pins at another version,
  reviewers skipped, refusals listed), the Save, plan and Use from library dialogs on a mocked API (the consent box, a
  `412` offering Save anyway, "Link to the existing Mira" with Escape closing only the plan over the picker, items
  checked under another search or tag used too), a resource row naming the resource that holds the version it would add,
  and the Library page: its changes with the item's revision (Make current, Archive; a change made meanwhile reloaded
  and said), no action bar for someone with nothing to do, singular counts, a style called Style, and Used in saying why
  it could not be read with Try again ([the library](design/library.md#tests)).

- **web, settings, workspace and library** (`settings.test.tsx`, `workspace.test.ts`, `runtime.test.ts`,
  `embed.test.tsx`, `library-build.test.ts`, `pwa.test.tsx`): the Settings page (sections from the table and the
  hash, search across sections, locks, advanced settings opening by themselves, secrets set, replaced and removed
  without being shown, only changes saved, checks while typing, server errors under the setting and their section
  opened, a confirmation before running jobs restart, endpoint cards with their status, what they call and a test
  that asks to save first, people who are not administrators); the IndexedDB workspace on fake-indexeddb (folders, ranges, preconditions in
  the transaction, moves without copying bytes), the provider (inline and transferred payloads), project files out
  of and into the browser and the service worker's ranged answers from IndexedDB (never creating the database); URLs
  under a `<base>` and of a server on another origin, `ws=` on media in browser storage; `mountRideo` (the host's
  theme over the studio's, memory routing, `navigate`, `setTheme`, a person's mode winning, nothing set on the host
  document); the scoped stylesheet (selectors, flattened layers, global keyframes); inlined worker scripts made
  same-origin; the service worker under a subpath scope.

- **server, observability and feedback** (`usage.test.ts`, `feedback-service.test.ts`): usage attributed to the job
  whose handler made the call (nested calls, none outside a job), prices from the gateway's reported cost or the
  table, unpriced usage, discarded attempts, the project ledger written behind and read back (a failed read made again,
  an unreadable ledger never written over, a false 404 read again, a missing one rebuilt from the jobs); the new metrics
  (`rideo_job_wait_seconds`, lane gauges, LLM seconds and tokens, HTTP route latency, storage buckets to 300 s);
  the retrospective rules on fixtures (each rule firing and staying quiet); applying and dismissing recommendations
  (`feedback_stale`); the telemetry endpoint (validation, the cap, off).

### Integration

- **Autopilot** (`autopilot.test.ts`): a new project's defaults (every review on) taken from the brief to
  the export on autopilot: each gate approved by the system after its review (screenplay, cast, storyboard, cut;
  `resources_ready` at once), the cast approved and locked by its review, every clip's frames approved
  before its video, every take watched whole by the vision model, every scene watched as one video and passed, the
  production scenes' storyboard reviews passed (the one written within the storyboard stage's scenes too: the stage
  draws only the scenes written by then), and the export queued for a studio tab; a cast review that still fails
  after its rounds keeps the gate for a person, who continues anyway; a reference drawn while the cast review waits for
  its model (`holdChat`) queues a review behind it that reviews the cast as it is now, and one whose change was undone
  ends without a model call. Takes watched whole: an attempt the mock sees
  morph (`motion glitch`) made again and kept failed with what was seen; the cut's takes from before the watch watched
  from their videos (`takes.watch`).
- **Storage conformance** (`storage.test.ts`): one suite against `MemoryBackend`, the embedded WebDAV server
  and (optionally) an external server: read/write/stat/list/move/delete, nested MKCOL, streaming, ranges,
  conditional writes when advertised.
- **Settings** (`settings.test.ts`): a studio started without mm-gateway is ready, refuses AI work with
  `gateway_not_configured` and edits footage end to end (rule-based suggestions, auto edit, an export with evenly
  spaced thumbnails); the settings view (sources, locks, no secrets), locked, unknown and invalid values, connection
  tests that save nothing, connecting the gateway (applied at once, audited without values, kept across a restart),
  a change the studio cannot start with rolled back, and the same over MCP; API keys against the mock gateway's
  management API (the key registered as the proxy's account with the provider's header, the studio's own gateway key
  used for it and its text model answering through it, a second endpoint sharing the key, the endpoint statuses,
  a refused admin token reported without undoing the save, a cleared key removed from the gateway, endpoint tests).
- **Browser storage** (`browser-storage.test.ts`) with a Node **reference workspace** (`test/helpers/workspace-client.ts`,
  the protocol over a real live socket and the HTTP transfers): nothing kept without a browser, projects created in
  the asking browser and listed to it, media in and out (ranges inline, whole files transferred), jobs and their
  records in the browser, a server restart followed by the reconnecting tab, a project file exported and imported
  into another browser as a copy (history rewritten, media served), the trash, `storage_offline` when the tab is gone.
- **Embedding origins** (`embedding.test.ts`): preflights and calls of `RIDEO_CORS_ORIGINS` answered with the CORS and
  CORP headers (a preflight allowing the desk state's `x-desk-state-format`, `x-desk-state-version`,
  `x-desk-state-replace`, `if-match` and `if-none-match`), others not; the live channel refused to other sites (4003).
- **Render plan** (`render.test.ts`): the shared chunk graphs and soundtrack graph run through native ffmpeg
  (a cut followed by a crossfade; a split and trimmed clip before a wipe, with speed and fades; text) and
  every chunk must have exactly its planned frame count; the concatenated chunks must equal the planned
  length. The editing tools: a cut with a freeze frame, a dip to white, a slide, a circle, a mirrored and adjusted
  item and a keyed overlay at exact frame counts; a freeze holding one frame and a mirror's pixels; a dip, a slide and
  a circle at the colors the compositor's arithmetic gives; a hidden primary track black; the adjustment, vignette and
  key filters against `color.ts`, value for value.
- **Editor jobs** (`editor-jobs.test.ts`): the REST protocol with a Node **reference editor worker**
  (`test/helpers/editor-worker.ts`) that implements the browser's jobs with native ffmpeg and the same shared
  planners: claim/lease/heartbeat, staged uploads, resume after a lost lease, cancel, and the follow-up
  jobs; a lease kept by heartbeats on the live WebSocket alone, refused to another session, and expiring when they
  stop.
- **Busy storage and an overloaded provider** (`overload.test.ts`): a studio on the scripted flaky WebDAV server: a
  loaded project's reads ask the storage nothing; a save goes through `423`s, a `503` and a dropped connection (the
  retries in `/metrics`); after a restart a false 404 for the project is looked at again; the work tree catches up; a
  project deleted while the server refuses to move it into `trash/` (OpenList on a cloud drive) is renamed where it
  is and no longer listed.
  The mock gateway turns two chat calls away (`overloadChat`): the screenplay is written anyway, with
  `rideo_llm_retries_total` counting them.
- **Provenance** (`provenance.test.ts`): the development signer's certificate chain verifies with
  `node:crypto`; a footage export is signed as a C2PA composite of its source, with the policy label burned in
  and recorded, bound to its watermark, and trusted by the C2PA SDK given the dev CA; uploaded likenesses need
  a consent record (`consent_required`); with `RIDEO_API_TOKEN` set, the public detection endpoint accepts
  uploads without the token (reduced response, size cap) while `{uri}` and every other route still need it.
- **Watermark robustness** (`watermark.test.ts`): embed into an ffmpeg-generated textured clip, then detect
  after x264 CRF 23 and 28, VP9, a 2 s trim, a metadata strip, and a downscale/upscale. Assert no detection
  on the unmarked source.
- **SDK contract** (`mock-gateway/test/contract.test.ts`): the real `@sloth-os/mm-gateway-ts` SDK against the
  mock (create with an idempotency key, poll, model limits, a problem as an axios error with its status and code).
  Responses are validated against the vendored gateway `openapi.json` (`mock-gateway/openapi/`, the spec the SDK is
  generated from). The proxy answers the post-audio
  tasks (`score.plan`, `sfx.plan`), ElevenLabs sound generation, `dialogue.translate`, `reframe.focus`,
  `thumbnail.pick` and `frame.caption` (colour, light and the known names), OpenAI-style embeddings (in order,
  synonyms close), `mock-enhance-v1` upscales and interpolates, and `mock-performance-v1` acts a performance from the
  first frame for the performance's length. The management subset: the redacted configuration (`ManagementConfigResponse`)
  behind its own token, writes refused without `If-Match` (`428`) or with a stale one (`412`), `[redacted]` values
  kept (and refused on a new account), and a registered proxy served to the keys its tags allow with an account's
  credential (`403` for another key, `404` for an unregistered domain in strict mode).
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
- **Director's desk** (`desk.test.ts`): `desk-brief` and the MCP tool `desk_brief` return the same brief; the desk state
  stored as an immutable media file the clip names, given back with its format, version and `ETag`, the same bytes again
  changing nothing, a commit per state coalesced per clip and author, a Replace (`X-Desk-State-Replace: 1`) a commit of
  its own that keeps the replaced state in the history, a restored clip with its state, `DELETE`; `404` only when no
  state is named, `503` `storage_error` for a named state whose file is gone, cleared by a `DELETE`; a `PUT`'s
  precondition (`If-None-Match: *` and `If-Match` stored or refused with `412` `desk_state_conflict` and the stored
  `ETag`, which the answer's `detail` names, or says the state was cleared, the `ETag` a `PUT` answers, the same bytes
  accepted whatever the precondition, a `PUT` without one replacing whatever is stored, conflicts counted and logged, no
  media file kept for a `412` found before the bytes are kept), checked again in the commit once the body has arrived (a
  state stored while a slow body arrived is kept); states over 64 MiB refused by their `Content-Length` and as a chunked
  body arrives (413), other formats, versions and every other body type, malformed and empty JSON included, never parsed
  (422), each counted as `refused` and logged; a request aborted before the service reads its body leaving no temporary
  file or open file; clip ids such as `constructor` and `__proto__` answered `404`; a partial camera through `PATCH` and
  `shot_update` keeping framing and movement; the state kept in the browser's storage; `RIDEO_DESK_URL` saved and
  reaching `GET /api/config` as `features.desk`. Library units: `X-Desk-State-Units` kept on the clip with its state
  (`-` as none, no header as unknown), a header that does not parse refused with `422` and counted, the same bytes
  again keeping the rows, a `DELETE` clearing them; the embedding origins' preflight allowing `x-desk-state-units`
  (`embedding.test.ts`).
- **Library** (`library.test.ts`): a desk set uploaded, listed, read, served with `Range`, `304` and `HEAD`, a new
  version with a stale `If-Match` and with a stale `basedOn` (`412` `library_conflict`), renamed, archived (gone from
  the default list, still served) and its uses; Mira saved from project A (`consent_required` until acknowledged), used
  in project B with the same id and seed and her references copied, a v2 from A making B's status `behind`, B's dry run
  and update (lock + 1); a name conflict linking instead; a resource used as a new resource; an image resource that is
  an SVG or a page refused (`payload`), a PNG kept as one whatever its part says, and a library file and a project's
  media served with `nosniff` and a sandboxing policy; a figure pinned on a
  character and a set on a location, unpinned again; the audit events and the metrics. MCP's `library_*` tools give the
  same answers on the same server; with projects in browsers, the library stays in the data directory, an apply goes
  through the tab that holds the project and fails with `storage_offline` without it. The editor refused an approved
  clip's update and the scoped token refused publishing are unit tests (`library-store.test.ts`).
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
- **Accounts** (`accounts.test.ts`) with the mock identity provider: sign-in with PKCE and a nonce, the session
  and sign-out, allowed domains and safe return paths; a director's project, members by email and an invite that
  becomes a membership at sign-in; what reviewers, editors, directors and outsiders may do (403s), studio visibility,
  admins and the studio token; agent tokens capped by role and projects over REST and MCP (commits by the agent on
  behalf of its owner, MCP sessions bound to their caller, revocation); people disabled by an admin; the audit log
  for admins and directors; live subscriptions refused to people without access; the guards decided by the matched route
  however the path is percent-encoded (without a session, `/%61pi/projects`, `/%61pi/library/items`, `/%6dcp` and
  `/%6detrics` answered `401`; a non-member under a project id with an escaped letter, its library routes included, and
  an editor's `appro%76e` answered `403`); a malformed project id (`not-an-id`, another case, too short, another kind's
  id, an escaped path) answered `422 validation_error` to a member, a non-member, an admin and the studio token on every
  project route, the library's included, before any permission is asked; a library upload from a reviewer token answered
  `403` before its parts are read (a person's for an item that is not there `404`), nothing written to the temporary
  folder.
- **Installable app** (`pwa.test.ts`): devices subscribed (https only), a failed recipe pushed to them encrypted and
  VAPID-signed (decrypted as the device would), a device its push service forgot dropped, unsubscribing; the Inbox
  across projects (an agent's review and commit, the gate, today's failures).
- **Cross-origin isolation** (`isolation.test.ts`): COOP and COEP on the studio, its assets and its routes;
  none with `RIDEO_CROSS_ORIGIN_ISOLATION=off`.
- **Performance** (`performance.test.ts`): a WebM recording set as a shot's performance; the model reported, none
  when the project turns them off (`422 performance_unavailable` on a regenerate); the take on `mock-performance-v1`
  from the keyframe, verified, as long as the performance and with its sound; the metric; MCP `performance_model`.
- **Search** (`search.test.ts`): footage (night, then day) and a still indexed by words, the best frame of each file,
  kinds, nothing asked twice, a new upload indexed on its own once search is in use, the metrics; a story project's
  takes and references with embeddings (`semantic`): synonyms found, a character's takes named first, an unapproved
  reference dropped on its own; MCP `media_search`, `search_status`, `search_index`.
- **Brand kits** (`brand.test.ts`): a kit with fonts (a broken one refused), a logo, a video intro and an outro still,
  served back; the bug set; the kit applied to a project (files copied into its media); a lower third and an intro
  that moves it; an export with the bug checked pixel by pixel (the logo in its corner over the intro), its length;
  the brand removed and the kit deleted; MCP `brand_kits_list`, `brand_kit_update`, `project_brand`.
- **Agents** (`agents.test.ts`): studio recipes validated (unknown tools, arguments, placeholders, a step that is
  `library_apply` refused with the step and the tool named, a recipe of `library_status` saved and run) and run with
  `forEach` over a list parameter, a failing step stopping the recipe with its error, built-ins that cannot be
  deleted, metrics; the built-in *Cast every voice* designing, choosing and locking the voices; MCP prompts filled
  with the scene (and refused for an unknown one), the new resources, `batch_variations` on a planned clip, a
  recipe created and run by an agent, and an agent's recipe that names `library_save` refused.
- **Editor depth** (`editor-depth.test.ts`): `.cube` LUT uploads (and a broken one refused); a cut with a LUT, a
  ramped item and a keyframed picture-in-picture on an overlay track rendered by the reference worker and checked
  pixel by pixel (the LUT's colour, the overlay where its keyframes put it, the ramp's source frames, the length);
  *Remove the background* on an overlay with the mock's segmentation model (the matte stored, the tracks below around
  the subject in the render), `segmentation_unavailable`, metrics; word timings with punctuation from speech-to-text
  and the filler words cut with `remove_ranges`; MCP `timeline_apply` and `timeline_remove_background`.
- **Feedback** (`feedback.test.ts`): a story export on the mock gateway gets its feedback by itself: the signals
  (an unexpected cut planted in a take with `metadata.mock_jump`), a vision call per scene with strips, the film call,
  scores, issues at the right export times, the retrospective and the report on WebDAV; applying a `regenerate_shot`
  recommendation updates the shot and makes a new passing take; dismissing; on request over REST and MCP; a studio
  without a gateway writes signals and the retrospective only. With an audio-visual model (`RIDEO_OMNI_MODEL`), each
  scene is heard as a video: a shot whose speaker mumbles is kept after three attempts with its line not heard, and
  its feedback has the `dialogue` score, the missing line, a regenerate recommendation and `undelivered_lines`.
- **Continuity** (`continuity.test.ts`): a version 2 project's writing and planning inputs (the brief, the level, the
  previous shot) and outputs (lens, end state, dialogue fitted to 5 s shots), the first shot of a clip generated before
  the others with its keyframe as the scene reference of the rest, a take that jumps (`MOCK_JUMP_EVERY`) retried by
  the temporal check and a physics failure by the judge, the kept take marked when all attempts fail; version 1
  projects unchanged; the sound check (an audio-visual model): every take records what was heard, and a take whose
  line is not heard (`muffleSpeech`) is generated again; a cast member who "photobombs" a shot that is not theirs fails
  the keyframe and the video three times each, and the kept take names the extra.
- **Re-check** (in `continuity.test.ts`): takes made with the judge off are `unverified`; with the judge back,
  `consistency.recheck` turns them `passed` from their evidence frames without a new generation.
- **The project's names** (`writer-names.test.ts`): a new project's writer gets no `existing`; a project that holds a
  locked character and a location with an alias before its screenplay gets them in `existing` for
  `screenplay.generate` and `screenplay.extend`, and the mock writer, which keeps those names as the real one is told
  to, makes scenes that link to them: one character of that name, unchanged (same id, seed and lock), the first scene
  at that place, and no second element for it.
- **Observability** (`observability.test.ts`): a clip generated on the mock fills `job.usage`, the project's
  `.rideo/usage.json` (priced with `RIDEO_PRICES`) and `/metrics`; `GET /insights` and MCP `project_insights`.
- **Interchange** (`interchange.test.ts`): an edit project's cut handed off in the four formats (the OTIO's clip URL
  fetched from the embedded WebDAV server is the uploaded file, byte for byte; mounted paths as `file://` URLs; the
  EDL's events, dissolve and speed line); an empty animatic refused; a re-edited OTIO (clips swapped and trimmed, a
  clip from elsewhere) imported in one commit keeping item ids, the music and the titles; multipart files; refusals;
  MCP export and import.
- **Review** (`review.test.ts`) with the mock identity provider: comments with drawings and mentions, replies and
  notifications, who may resolve; a review with a share link (the guest view holds only the clip's selected takes,
  media outside it and project routes are refused, wrong tokens are 404), guest comments, replies and decisions, a
  gate that cannot be approved yet and then is, in the director's name and audited; revocation; metrics; agents
  listing, answering and resolving notes over MCP with an editor token (and refused a review).
- **Finishing** (`finishing.test.ts`): a YouTube delivery upscaled and interpolated by `mock-enhance-v1`
  (1080p, 48 fps, the C2PA `upscale` action, three signed thumbnails); the ffmpeg fallback with `models.enhance:
  off`; a ProRes master (10-bit 4:2:2, PCM, signed, stems); an image-sequence master (a TAR with every frame, the
  sound and the subtitles); a vertical cut-down prepared by `export.prepare` (focus tracks on the takes, a 9:16
  render timeline, the length), and a square one reusing the focus. The reference editor worker pings the live hub
  like a tab, so long specs keep their session.
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
- **WebDAV editing** (`webdav-sync.test.ts`): the work tree appears behind the commits; edit `screenplay.json` through
  the WebDAV client and sync (a commit by `webdav`); an invalid edit raises a `sync-issue`; the inbox import creates
  resources.
- **Recovery** (`recovery.test.ts`): kill the server mid-generation, restart, and check the job resumes with
  the same gateway idempotency keys.

### End-to-end (Playwright)

Projects: `desktop` (1440×900) runs every spec except `responsive`; `mobile` (412×915, touch) runs
`responsive`, `mcp-sync`, `provenance`, `elements`, `dialogue`, `storyboard`, `director-desk`, `directing`, `take-editing`,
`multi-shot`, `post-audio`, `localization`, `finishing`, `accounts`, `review`, `interchange`, `editor-depth`,
`editing-tools`, `recipes`, `brand`, `search`, `performance`, `engine`, `pwa`, `settings`, `browser-storage`, `subpath`, `embed`,
`feedback`, `insights`, `library` and `desk-units`. The
web server stops with SIGTERM so the stack removes its data; stale stack directories older than an hour are removed
when a new stack starts. Specs:

| Spec | Flow |
|---|---|
| `story.spec.ts` | brief → screenplay → cast (generate, approve, lock; design, pick and lock every voice; then the locations and props in the Elements view) → storyboard (generate, approve all frames, approve) → pilot from the approved frames (the speaking take carries TTS dialogue) → approve → batch (30 s target) → approve → editor (assemble; the Dialogue track holds the mixes; split, inspector trim, edge-drag trim; the preview plays local proxies because H.264 is hidden from WebCodecs) → export rendered in the tab (`auto` → ffmpeg.wasm) → verify watermark |
| `mcp-sync.spec.ts` | page open; the test drives MCP tools as “Claude Code” (create character, add reference, lock, `ui_navigate`, `ui_focus`, `ui_notify`) and asserts the page updates live, attributed to the agent, without a reload; an agent's `export_render` is claimed and rendered by the open tab (`auto` → WebCodecs) and watermarked by the server |
| `footage.spec.ts` | upload (probe + poster in the browser) → analysis signals in the browser → AI suggestions → accept → auto edit → exports with the ffmpeg.wasm and WebCodecs engines → both listed and verified |
| `history.spec.ts` | edit → history → diff → restore → UI updates |
| `take-editing.spec.ts` | (desktop and mobile) relight a take and extend another by 2 s from the take tiles (lineage badges); generative extend of the first item in the editor (the lanes on desktop, the item list on phones) |
| `accounts.spec.ts` | (desktop and mobile, on the stack's second server with accounts and a mock identity provider) sign-in; a director adds a reviewer by email in the Members card; an agent token created, used and revoked; people and the audit log; the reviewer's view (banner, no settings); sign-out |
| `pwa.spec.ts` | (desktop and mobile) the manifest and the service worker; the Inbox from the header: an agent's commit, a failed recipe, a gate approved; notifications on this device turned on and off (a stand-in subscription: headless browsers have no push service); the shell starting offline |
| `engine.spec.ts` | (desktop and mobile, WebGPU on SwiftShader through Vulkan) the studio cross-origin isolated; the same graded, overlaid frame from WebGPU and the canvas; an ffmpeg.wasm export on threads; a WebCodecs export composited by WebGPU in a hidden tab (worker heartbeats, the job's Web Lock); a 4K original previewed from a WebCodecs editing proxy in OPFS. A cut of 40 quarter-second items exported with ffmpeg.wasm, its threads planned for 8 cores: the chunk and the soundtrack read their 40 inputs on the main thread and stay in the 32-thread pool. A cut of 40 different clips opened through the stack's slow-media proxy (every ranged media read held 20 s on the browser's six HTTP/1.1 connections): the tab claims the queued export at once and finishes it on its first lease (with every lane reading at once, the claim, the heartbeats and the export's inputs waited minutes behind the held reads and the lease was lost) |
| `performance.spec.ts` | (desktop and mobile, a fake camera and microphone) a performance recorded on a shot: countdown, recording, stop, playback, used as the shot's performance; the model shown; the regenerated take acted by `mock-performance-v1` and verified |
| `search.spec.ts` | (desktop and mobile) footage and a still indexed from the Search view, found by words at the matched frame, filtered by kind, *Show* in Resources; the editor's overlay picker finds the still and puts it at the playhead |
| `brand.spec.ts` | (desktop and mobile) a brand kit made on the Brand kits page with a logo and the bug on; applied to a project from its overview; a lower third from the kit's template in the editor; the export with the bug (on by default) rendered in the tab |
| `recipes.spec.ts` | (desktop and mobile) a studio recipe (a title per text) run from the overview's Recipes card with its parameter; the titles in the cut; the recipe deleted |
| `editor-depth.spec.ts` | (desktop and mobile) footage added as an overlay at the playhead, the picture-in-picture preset, *Remove the background* (the mock's segmentation model); an ease-in ramp and a `.cube` LUT uploaded from the inspector on the primary item; filmstrips and waveforms in the lanes (desktop); the layered cut exported with ffmpeg.wasm; the analysis's transcript and *Remove filler words* splitting the picture track |
| `editing-tools.spec.ts` | (desktop and mobile) desktop: a marker with `M`, named; `S` splits, `Ctrl+Z` and `Ctrl+Shift+Z`; `Ctrl+D`; a freeze frame from the context menu; detached audio dragged 0.93 s onto the marker (snapping, with its guide) and down onto the Music track; a locked track refusing `Delete`, a hidden one; mirror, exposure, chroma key and a slide on the last item; `?`; the cut exported with ffmpeg.wasm, its threads planned for 8 cores (the page reports 8) so the 32-thread pool is met on any machine. Phones: a marker from the Markers card, a freeze frame, mirror, *Undo*, *Redo*, *Duplicate* and an adjustment from the inspector, *Unlock* of a locked track; no sideways scroll. A slow server (every op held 1.5 s): two markers and a freeze frame made at once wait in order ("Saving 3 edits…"), *Undo* pressed meanwhile takes back the freeze frame only, and history shows the commits in the order made |
| `interchange.spec.ts` | (desktop and mobile) the Exports view's hand-off card with a mounted media location: the OTIO download points into it (remembered after a reload), FCPXML, XML and EDL download; a re-edited OTIO (trimmed, plus a clip from elsewhere) imported: one clip placed, the stranger listed |
| `review.spec.ts` | (desktop and mobile) a note at 0:01.0 with a box drawn on the take, a reply, resolved (the tile's open count); a review of the pilot with a share link deciding `pilot_approved`; the client, in a separate browser without an account, names themselves, draws an arrow, comments and asks for changes (no sideways scroll); the studio's bell leads to the note live; after the pilot clip is approved the client's approval approves the gate; the revoked link opens nothing |
| `finishing.spec.ts` | (desktop and mobile) a vertical delivery from the export dialog: focus tracks prepared, reframed, cut down, upscaled by the enhancement model, three thumbnails on the card; a ProRes master listed with its download and stems |
| `localization.spec.ts` | (desktop and mobile) captions set to word by word; Spanish added with dubbing (the close-up lip-synced); a line corrected in the translations dialog makes its dub stale until *Dub* runs again; the dubbed Spanish variant exported with sidecar subtitles (language badge, VTT download) |
| `post-audio.spec.ts` | (desktop and mobile) the Mix card: ducking on after assembly, depth −18 dB, *Score the cut* with a direction (Cue 1 on the Music track), *Add sound effects* (an Effects track, its lane on desktop); an export rendered in the tab at broadcast loudness with stems; the export card shows about −23 LUFS and the three stem downloads |
| `multi-shot.spec.ts` | (desktop and mobile) the multi-shot setting off and on in the project settings; a clip on `mock-multishot-v1` renders two shots in one request (`shot 1 of 2`, `shot 2 of 2` badges) and the third alone |
| `directing.spec.ts` | (desktop and mobile) the Direct panel sets a push-in, an 85 mm lens, f/2 and a generated end frame; two variations are generated, compared side by side and B is chosen |
| `director-desk.spec.ts` | (desktop and mobile, against the fake desk on its own origin) the Storyboard view's *Director's desk* on a planned scene: the panel connects (the page behind it inert, no Follow menu of its own, the desk opened on *Camera*, the iframe sandboxed without top navigation), the desk's **Send** attaches every shot's clip as its motion reference with the staged lens and move, the planned framing and movement kept (checked through the API: the resources ready with their probe and JPEG poster) and the toast names the mode and lists the shot whose camera disagrees with the plan; the state stored on Close and given back on the next open, opened and closed without an edit storing nothing (the same file, no commit), the desk's own **Done** storing its last state; an edit stored when the person leaves the view with the browser's back instead of Close; a state another session stored meanwhile kept at Close (the panel stays with the notice, Close again closes), and so is a state this tab stored that another session put back after storing another one (a restore: the tab saw the server move past it); a partial result attaching the shots it has, with the desk's `export_failed` in a toast; a stored state the desk cannot read kept (notice and toast, an edit not stored on Close) until **Replace the stored desk state** after its confirmation; a stored state the server cannot read: the panel failed with **Retry**, the desk not opened until Retry, and **Start over** after its confirmation clearing the state and opening the desk from the brief; *Poses* chosen in the desk's own Follow menu, attached and remembered for the project after a reload, and a shot the desk sent longer than its brief refused with "set its length back in the desk"; a desk opened on a state staged before the brief retimed the first shot (`opened` lists it): sent longer, that shot refused with "press Update shots in the desk", and after the desk's Update shots with "set its length back in the desk"; a desk page served without its headers: the timeout message after 15 seconds, Close still closing; an approved clip opened read-only and its result refused; the v1 fake desk getting no unit field though the scene's location pins a library set; no sideways scroll |
| `library.spec.ts` | (desktop and mobile) Mira saved to the library from episode 1 through the consent dialog, used in episode 2 from the Cast view's picker (the same id and seed, checked through the API), episode 2's screenplay written by the writer keeping her (its scenes cast her id), a project with a Mira of its own offered "Link to the existing Mira" (Mira kept checked under another search, Escape closing only the plan over the picker, then plan, consent, linked and locked), a v2 published from episode 1 and the update in episode 2 with its plan and the approval warning of its approved clip, the item's Used in; desk units uploaded through the REST API: a location's 3D row Choose (sets only), Use v2, the Library page's search, kind chips and tag filter (the list kept beside the item on a wide screen, the item alone with its action bar on a phone), Use v3 for the project and Use v4 in every project, a tag added, a prop archived (gone from the list and the props' picker, back under Show archived), Change and Unlink; no sideways scroll; on phones (360×740, 390×844, 412×915 at a device pixel ratio of 1) the Cast, Elements and Resources cards keep long names whole beside their badges and Save to library ([the library](design/library.md#tests)) |
| `desk-units.spec.ts` | (desktop and mobile, on the units studio with the fake desk in units mode) a scene whose place, cast member and prop are pinned opening with their pins in slot order and their bytes (sha256 checked), the state's units recorded on the clip at Close, no badge, and the next open sending no file for the pins the stored state uses; **Publish set** on an unpinned place creating an item, linking the place in one commit and acknowledged `linked`; **Publish new version** making v2 and moving the pin; another scene at the place showing "3D: v2 available" until its desk opens again with v2's bytes; an approved clip's desk publishing, acknowledged not linked ("the scene is read-only"); no sideways scroll ([library units](design/director-desk.md#tests)) |
| `ai-review.spec.ts` | (desktop and mobile) the screenplay and the storyboard reviewed, revised by their review and passing before the next stage; the project settings' review gates at 8 (a new bar saved), frames corrected by editing them and how long the staging check reasons; one screenplay draft until the settings ask for more; the Story view's adapted brief; the cast review's panel in the Cast view passing; no sideways scroll |
| `storyboard.spec.ts` | (desktop and mobile) generate the storyboard, approve a frame, move it later, approve all; download the shot list CSV and PDF; build the animatic, play it, export it in the tab (listed as an animatic export); approve the storyboard; import a Fountain screenplay in the Story view |
| `dialogue.spec.ts` | (desktop and mobile) the Cast view's voice panel: design three voices, the previews play, pick one, lock it; clone a recording of a real person through the consent dialog and lock it; the gate stops asking for voices; the dialogue mode setting |
| `elements.spec.ts` | (desktop and mobile) the screenplay's location in the Elements view → generate, approve, lock; add a prop and link it to a scene in the Story view |
| `provenance.spec.ts` | (desktop and mobile) uploading a likeness opens the consent dialog; a real person needs subject, grantor and date and marks the character; the disclosure setting labels the export; the export card and the public Verify page show the Content Credentials |
| `responsive.spec.ts` | every main view on mobile: no horizontal overflow, navigation reachable, primary actions visible |
| `feedback.spec.ts` | (desktop and mobile) the project settings' continuity controls (dialogue level B1, continuity-aware prompts, quality checks, feedback after each export); a story export's feedback on its card (overall score, dimension bars, summary); *Show feedback*: scenes, an issue's *Play from here* seeking the export, a `regenerate_shot` recommendation applied (the shot regenerating, the recommendation marked applied) and another dismissed, the retrospective, the report download; no sideways scroll on phones |
| `insights.spec.ts` | (desktop and mobile) the Insights view of a generated project: cost (with `RIDEO_PRICES` on the stack) by model and job kind, times per job kind, take quality, the feedback score and the retrospective; the studio's telemetry reaching `/metrics` (`rideo_web_vitals_seconds`); no sideways scroll on phones |
| `settings.spec.ts` | (desktop and mobile, each on a studio of its own) without a gateway the dashboard says AI is off; Settings: sections and search, a locked value, the gateway tested, an invalid value refused under its field and its section opened, the gateway saved and applied (the dashboard and the live channel follow without a reload, a film can be started); the text model's API base URL and API key set with the gateway's admin token, registered in the mock gateway (the card says so, the vision card shares the key, **Test** answers), the key replaced and removed; then the gateway cleared again; no horizontal scroll |
| `browser-storage.spec.ts` | (desktop and mobile, on the studio without WebDAV and gateway) a project kept in IndexedDB with its upload and poster; its project file downloaded; deleted and imported back; imported again as a copy; still there after a reload. Desktop: analysis by rules, auto edit and an export rendered in the tab, the export stored in the browser and served by the service worker from IndexedDB |
| `subpath.spec.ts` | (desktop and mobile) the studio under `/studio` with the prefix kept and under `/rideo` through a prefix-stripping proxy: the bare prefix, the injected `<base>`, the live channel, a project's deep link reloaded, the MCP command, the manifest and the service worker's scope, no request outside the prefix, problems for unknown API routes |
| `embed.spec.ts` | (desktop and mobile) a host app built with Vite against `@rideo/web` on another origin: its theme and name, light mode, the host's styles and the studio's kept apart, the browser-storage studio reached across origins (live channel too), hash routes heard by the host, `navigate` and `setTheme` from the host, an upload probed by ffmpeg.wasm loaded from the host's build, the project in the host origin's IndexedDB; browser routing under the host's `/video` without the studio's header |

The e2e stack starts through Playwright's `webServer` (`e2e/support/stack.ts`, ports in `e2e/support/ports.ts`): the
mock gateway, the main studio with the embedded WebDAV (temporary data dir) serving the built web app, a studio with
accounts, one that keeps projects in browsers without a gateway (and allows the host page's origin), one under
`/studio` with a prefix-stripping proxy in front of it at `/rideo`, two whose settings the settings spec changes, a
slow-media proxy in front of the main studio (`e2e/support/slow-media-proxy.ts`: HTTP/1.1, every ranged media read held
20 s, everything else at once), the library's host page (`e2e/fixtures/embed`, built by `npm run build:e2e-host` against `dist-lib`),
and a fake 3D desk on its own origin (`e2e/fixtures/desk`, served by `e2e/support/desk-page.ts` on `localhost` with
the headers a desk page needs; the main studio's `RIDEO_DESK_URL` names it), and a units studio whose `RIDEO_DESK_URL`
is the same fake desk with `?units=1` (library units: the capability, pins and unit bytes, publishing, `state.units`)
while the main studio keeps the desk of before. The main studio
starts last, so its readiness means all are up. `npm run test:e2e` builds the app, the library and the host first. Tiny media sizes (320×180)
and short durations keep the suite fast. Playwright's Chromium decodes H.264 with WebCodecs, so the story
spec emulates a browser without an H.264 decoder (an init script hides AVC from `VideoDecoder`): the preview
must play through local proxies and `auto` must pick the ffmpeg.wasm engine. The footage spec renders with
both engines explicitly, and the MCP spec checks that `auto` picks WebCodecs when every source decodes.

## Real models (`e2e/real`)

The mock proves Rideo against the gateway's contract; the real-model suite proves it against the real thing: the SDK
and the proxy client against a real mm-gateway, the models' own answers through Rideo's schemas, and their pictures and
videos through the pipeline. It does not grade the models: an answer passes when it fits the contract.

| Variable | Secret | Example | Meaning |
|---|---|---|---|
| `IMAGE_MODEL_TYPE` | | `volcengine` | the mm-gateway backend type of the image model |
| `IMAGE_MODEL_BASE_URL` | | `https://ai.ctaigw.cn/v1` | its endpoint |
| `IMAGE_MODEL` | | `doubao-seedream-5.0-pro` | its id |
| `IMAGE_MODEL_API_KEY` | yes | | its key |
| `VIDEO_GEN_MODEL_TYPE` | | `dashscope` | the mm-gateway backend type of the video model |
| `VIDEO_GEN_BASE_URL` | | `https://ai.ctaigw.cn` | its endpoint: the API root, or for `dashscope` the host alone |
| `VIDEO_GEN_MODEL` | | `wan3.0-video-prime` | its id |
| `VIDEO_GEN_API_KEY` | yes | | its key |
| `VISION_MODEL_TYPE` | | `openai` | the API the vision model speaks: `openai` (or compatible), `gemini`, `anthropic` |
| `VISION_MODEL_BASE_URL` | | `https://ai.ctaigw.cn/v1` | its base URL, API version included |
| `VISION_MODEL` | | `qwen3.8-max` | its id |
| `VISION_MODEL_API_KEY` | yes | | its key |
| `VIDEO_GEN_DURATION_SEC` | | `5` (default) | the shot length the video model renders |
| `MM_GATEWAY_IMAGE` | | `ghcr.io/sloth-os/mm-gateway:sha-bca5bd9` (default) | the gateway image to run: the default delivers inline reference images to Seedream ([what older gateways do](design/first-pass.md#the-image-model-never-saw-its-references)), [says in the prompt what a backend has no field for](design/ai-gateway.md#sdk-usage), and has Wan 3.x's native requests (sound, first and last frames, references, the resolution tier) |
| `MM_GATEWAY_URL` / `MM_GATEWAY_API_KEY` | | | use a running gateway configured the same way instead |

```bash
export IMAGE_MODEL_TYPE=… # and the rest of the table
npm run test:e2e:real     # builds the web app, starts mm-gateway in Docker and a studio, runs e2e/real
```

`e2e/real/env.ts` validates the variables (zod; every missing one is named) and maps them, as data, to:

- **mm-gateway's configuration**: a backend per generation model (`IMAGE_MODEL_TYPE` with the model pinned as
  `extra.image_model`, `VIDEO_GEN_MODEL_TYPE` with `extra.video_model`) at its SDK's API root (a `dashscope` base URL
  that names only a host gets `/api/v1` on DashScope's hosts and `/v1` on a DashScope-compatible gateway: `ai.ctaigw.cn`
  serves the DashScope API under `/v1` and answers anything else with its catch-all); a proxy for the vision model at its base URL
  without the API version (Rideo's adapters add `v1/chat/completions`, `v1beta/…` or `v1/messages`), with the key in
  the header that API reads (`authorization: Bearer`, `x-goog-api-key`, `x-api-key`); one key for the studio; and the
  video model's shot length in `catalog.models`, so the shot planner asks for what the model renders. The file names
  the keys (`${IMAGE_MODEL_API_KEY}`); their values reach the container's environment only. The vision account's
  header value is made from `VISION_MODEL_API_KEY` for the run (`Bearer <key>`, or the key itself) and named whole
  (`${RIDEO_REAL_VISION_CREDENTIAL}`): mm-gateway since `c5dc21e` (October 18) encrypts a credential that is only partly a
  reference (`Bearer ${…}`) and writes it back with its key file beside the configuration, which the suite mounts
  read-only, so the gateway did not start.
- **the studio's environment**: the gateway and its key; the vision model as both the language model
  (`RIDEO_LLM_*`: the screenplay, the shot plans) and the vision model (`RIDEO_VISION_*`: attachments, the consistency
  judge, footage); the image and video models pinned; no speech, effects, embeddings or voice-judge provider.

`e2e/real/stack.ts` (Playwright's web server) pulls and starts the gateway image with that configuration, waits for
`/health`, then starts one studio on the built-in WebDAV server, which logs to `test-results/real/studio.log` (every AI
task with its model, latency and usage); on stop it saves the gateway's log to `test-results/real/mm-gateway.log`,
without any form of the keys (whole or masked), and removes the container. `e2e/real/env.test.ts` and `gateway.test.ts` (in
`npm run test:unit`) check the mapping for each vision API, base URLs with and without a version, the API roots of
hosts, the duration override, the missing variables and the redacted log.

| Spec | Real calls | Flow |
|---|---|---|
| `gateway.spec.ts` | vision: the text model's one-word `settings.test` | readiness asks the gateway's `/health`; `/api/config` lists the pinned image and video models through the SDK, the video model with the lengths of the gateway's catalog, and the vision model as the language and vision model; Settings tests the connection, and the text model's card answers its test with one real word through the proxy |
| `story.spec.ts` | vision: `media.describe`, `screenplay.generate`, `clip.plan`, `consistency.judge`, `feedback.scene`; image: references and keyframes; video: the pilot's shots | a brief with an image and a video attached → screenplay → one front reference per character and one view per element in use → cast locked (storyboard off) → the pilot clip planned in shots of the catalog's length: every shot gets a take with a keyframe from the image model and the vision model's verdict on it; at least one take has a video from the video model, started from its keyframe and judged on its frames (a shot whose keyframe fails the gate twice gets none); a scene of two shots or more is watched once by the vision model before the edit, and none of the watch's fixes is applied |
| `footage.spec.ts` | vision: `footage.analyze` | footage uploaded → analysis → the model's summary and suggestions next to the rules' → accept all → auto edit |

The suite checks the plumbing, not the quality, so its project asks for one screenplay draft and one judge answer per
review, and watches its scene once without applying the watch's fixes (`REAL_PROJECT_SETTINGS`, `review.sceneFixes` 0),
whatever new projects default to: more of them cost minutes on the real models, and have their own tests on the mock
gateway (`first-pass.test.ts`, `review-samples.test.ts`, `clip-review.test.ts`). The fixes, two shots made again and the
scene watched a second time, took 16 to 20 of `story.spec.ts`'s minutes, and with them it ran past its hour (November
2026). It keeps the checks of each frame against its shot (`frame.reconcile`, about 3 minutes a call) and of each
reference (`reference.check`, about 2), the only place they run on real models in CI, so `story.spec.ts` took about 45
minutes. It waits up to 30 minutes for the cast's views: the image lane draws two at a time, a view whose check finds a
difference is drawn and checked again, and a check can reason for over four minutes (four did on November 9, 2026, and
the 15 minutes the test then allowed ran out). On November 12 its shot plan answered twice without JSON and the 10
minutes it waits for the plan ran out: the model had begun to count its reasoning against the answer's token limit, and
the plan, which named no limit, got the provider's default ([room for the reasoning](design/ai-gateway.md#reasoning)). A
plan took 5.8 minutes on November 10. With the fix the suite passed again the same day, but `story.spec.ts` took 55.2
minutes: ctaigw, the provider behind the suite's models, had also stopped honouring `enable_thinking: false` and
`thinking_budget`, so the identity checks reasoned (46 to 141 s a call instead of 6 to 12) and the staging check
reasoned past its 2,048 tokens (206 to 284 s instead of about 63). So its limit is now 75 minutes instead of 60, and the
job's 90 instead of 75, while the provider reasons through every check.

Each spec also reads the studio's `/metrics` (`rideo_llm_calls_total`, `rideo_gateway_tasks_total`) to check that the
calls it expects were made and succeeded. The suite's projects judge with a threshold of 0.5 and two attempts per
keyframe and per video: the cost stays bounded, and a strict verdict on a good picture does not keep the video model
from being exercised. A run takes about an hour and costs a dozen or so images, a few short videos and a few dozen vision
calls. Retries are off: a failure is reported, not paid for twice.

### Measuring the first pass (`scripts/first-pass.mjs`)

The real-model suite checks contracts; it does not grade what the models make. `scripts/first-pass.mjs` does, against
a running studio on real models ([right the first time](design/first-pass.md#measuring-the-first-pass)): it creates a
project from a brief with every automatic fix off (`review.maxRounds` 0, `review.sceneFixes` 0,
`consistency.maxAttempts` 1), lets the autopilot make each step once, continues past every gate that does not pass as a
person would, and records the first round of every review (the stage reviews, each production scene's storyboard,
each scene watched before the edit, every first take watched whole) as JSON and a table against the bar of 8. It is
not part of CI: a run through the storyboard costs a few dollars of images and model calls and takes about an hour,
and `--until pilot` adds the pilot's video.

## CI (`.github/workflows/ci.yml`)

| Job | Runs |
|---|---|
| `lint` | Biome + `tsc --noEmit` for every package |
| `unit` | unit suites with coverage |
| `integration` | integration suites (ffmpeg installed via apt) |
| `webdav-compat` | storage conformance against Apache httpd 2.4 + `mod_dav` (`scripts/webdav/run.sh`) |
| `e2e` | Playwright desktop + mobile; traces and screenshots uploaded on failure |
| `real-ai-check` | on pushes to `main` and manual runs (never pull requests): whether the suite's variables and secrets are set (repository or organization); a notice names what is missing |
| `real-ai` | when they are: the real-model suite (`playwright.real.config.ts`); the keys reach that step only, not `npm ci`; the report, the studio's log and the gateway's (redacted) log are uploaded |
| `docker` | builds the production image (pushed to GHCR on `main`) |

Every job that installs uses `.github/actions/npm-ci`: `npm ci` with c2pa-node's native binary fetched with the job's
token and cached by its version. c2pa-node's own postinstall fetches the binary from a GitHub release without a token,
and falls back to a Rust build that cannot build the published package. On November 8, 2026, while GitHub timed out
some unauthenticated requests, that failed the install of most jobs, one of them on five runs in a row.
