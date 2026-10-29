# Improvements: what the demos taught us

The ten-minute demo of October 2026 (the story *Bao and Mei Learn to Surf*: 20 clips, 118 shots, a 9:45 export, then a
footage edit of that export) ran on a studio whose WebDAV server is OpenList over a cloud drive, where every request
takes 1.3–2 s, with an upstream LLM provider that was overloaded at times. What broke in it is fixed: slow saves and
false 404s ([slow and flaky servers](design/storage-webdav.md#slow-and-flaky-servers)), an editor tab that lost its
export ([editor jobs](design/editor.md#editor-jobs), [media requests](design/engine-performance.md#media-requests)),
LLM calls turned away for load ([structured tasks](design/ai-gateway.md#structured-tasks)) and projects that could not
be deleted. This page lists what can still improve. Each item gives the evidence, how it fits Rideo, and a rough
effort (S ≤ 1 week, M 1–3 weeks, L > 3 weeks for one engineer), like the [roadmap](roadmap.md).

Every project now writes its own list: the [feedback](design/feedback.md) on each export ends with a retrospective of
the run (cost, time, retries, failures, the film's weakest dimensions), and the [Insights](design/observability.md#insights)
view shows it next to the numbers. After each demo, what it taught is added here.

## Measured on the demo server

After the fixes, on the demo server:

| What | Time |
|---|---|
| A save (a screenplay edit), median | 4.8 s: two storage round trips |
| Creating a project | 18 s |
| `GET /state` of a loaded project, on the server | 9–14 ms |
| `GET /api/projects/:id/history?limit=100`, first after a restart | 26.5 s |
| `GET /api/inbox`, first after a restart | 18–38 s |
| `GET /api/projects` (7 projects), first after a restart | 15 s |
| Storage reads that gave up after their retries, in the 15 minutes after a redeploy | 66 (17 × `500`, 15 × `503`, 34 × false `404`) |
| Uploading the 419 MB export to WebDAV (export finishing) | about 6 min |
| Overriding the consistency check of 94 takes | one commit each (about 20 min before the fixes) |

## Storage and version control

**1. A project loaded once, not once per request** (S, done) — after a restart, requests that arrive together (a page's
`/state` and `/history`, the Inbox, the project list, sync) each load the same project's whole document set:
`Repository.state()` does not share a load in progress. After the redeploy of 25 October, while the 118-shot project
was loaded by several requests at once, 66 storage reads gave up (17 answered `500`, 15 `503`, 34 a false `404`) and a
project create answered `503`. *How:* the requests share the load in progress (one promise per branch). *Done:* requests that arrive while a project loads share the load in progress (one per branch) ([slow and flaky servers](design/storage-webdav.md#slow-and-flaky-servers)).

**2. Bounded parallel reads when a project loads** (S, done) — a project's documents are read all at once (one `Promise.all`
over about 150 objects for the 118-shot project). OpenList answers such bursts with `500`, `503` and false `404`s, and
the retries add to the burst. *How:* read at most 8–16 objects at a time, as a commit writes at most 8. *Done:* a project's documents are read at most 12 at a time.

**3. Pages wait for history on a cold start** (S, done) — the project store loads `/state` and `/history?limit=100`
together and shows nothing until both answer (`web/src/store/project.ts`), and the first history after a restart took
26.5 s. *How:* render from `/state` and fetch history in the background; on the server, read the recent log into the
commit cache when a project loads. *Done:* a page renders from `/state` and the history fills in when it arrives; opening a project's state reads its recent log into the object cache in the background ([maintenance](design/storage-webdav.md#maintenance)).

**4. A recent-log file per branch** (M, done) — a log walk reads one commit object at a time (a commit names its parent, so
the next read waits for the last), so 100 commits cost 100 round trips on a cold cache. *How:*
`.rideo/logs/<branch>.json` with the last 200 commit summaries, written behind the commit like the work tree; a cache,
rebuilt from the objects when it is missing or behind the ref. *Done:* each branch's last 200 commit summaries are kept in memory and in `.rideo/logs/<branch>.json`, follow every commit (a coalesced one takes the place of the tip it replaces) and are written behind them; a file behind the tip is caught up by reading only the newer commits, and older pages go on with the walk ([the recent log](design/version-control.md#caching)). On the demo server a project's first history after a restart now takes 0.7–1.7 s.

**5. The project list and the Inbox from summaries** (M, done) — `GET /api/projects` and `GET /api/inbox` load every
project's whole document set, one project after another, walk its log, and list the projects folder on every call
(15 s and 18–38 s cold). *How:* a per-project summary (title, stage, durations, poster, open reviews, the gate to
approve, recent agent commits) kept in memory and in `.rideo/summary.json` behind the commits; projects read in
parallel; the folder listing cached and refreshed on create, delete and import. *Done:* both read each project's summary (`.rideo/summary.json`, kept in memory and written behind the commits; checked against the branch's tip and made again from the documents when behind), 8 projects at a time, and the WebDAV listing of the projects folder is reused for a minute (`rideo_project_digests_total{source}`). On the demo server, cold after a restart: 32.9 s for the project list and 103.9 s for the Inbox before; 2.4 s for the list after (its nine summaries read from their files), and the Inbox at once after it. The first list after the deploy made every summary from the documents (61.7 s, once).

**6. One commit for many changes** (S–M, done) — a save is still two round trips (about 4–5 s on OpenList), and the demo made
one commit per take override (94) and per editor operation. *How:* approve and override many takes in one call (REST
and MCP); the editor sends its queued edits as one request when several wait ("Saving N edits…"); on the server,
transactions waiting on the project lock committed together. *Done:* `transactMany` writes a group of commits (each its own entry and its own undo) with one batch of objects and one move of the ref; the editor sends the edits that wait while one is saved in one request (`POST /timeline/ops {batches}`), and `POST /takes/override` (MCP `takes_override`) overrides many takes in one commit ([several commits at once](design/version-control.md#commit-protocol)). Transactions from different callers are still committed one at a time.

**7. Exports ready before the WebDAV upload ends** (M, done) — export finishing uploads the watermarked file to WebDAV before
the export is ready: about 6 minutes for 419 MB. *How:* ready once the file is in the local media cache (served from
there), uploaded in the background with retries, the export card saying so until the file is on WebDAV. *Done:* an export is ready once its file is in the server's cache (the studio serves media from there first) and is written to WebDAV in the background (`putFileBehind`): listed in `uploads.json`, never evicted while it waits, tried again after a failure and resumed after a restart; the export's `upload` is `pending` until then and the card says *Uploading to storage…* ([an export ready before its upload](design/storage-webdav.md#local-cache-and-staging)).

**8. ETags from PUT answers** (S) — every work-tree batch lists each folder it wrote to, only to learn the new etags.
*How:* take the ETag from the PUT answer when the server sends one (the `webdav` client's `putFileContents` does not
return headers; a custom request does). *Not done:* OpenList answers a PUT with `201` and no `ETag` (checked on the demo server on October 28), so taking the ETag from the answer would save no listing there; kept for servers that send one.

**9. Media reads that survive a hiccup** (S, done) — `readStream` retries its `stat` but not the stream itself, so a `500`
from OpenList at the start of a media read reaches the browser. *How:* retry the GET until its first byte arrives. *Done:* a media read is tried again until its first byte arrives.

**10. Projects deleted outside Rideo** (S, done) — a project is looked up once per process; sync's `verify` notices a deleted
folder, but sync runs only for projects with live subscribers, so a folder deleted over WebDAV stays served from
memory until a restart. *How:* drop project handles left idle for a while, or verify loaded projects on a slow timer. *Done:* every 10 minutes the loaded projects are looked up again and the ones whose folder is gone are forgotten (`rideo_projects_vanished_total`).

**11. Emptying the WebDAV trash** (S, done) — `trash/`, and `projects/<id>.trashed-<time>` on servers that cannot move a
folder into another, are never emptied (a browser's trash is emptied after 7 days). *How:* a scheduled purge after
7 days, with a metric and a log line per project removed. *Done:* a minute after start and then daily, deleted projects older than 7 days are removed for good (`rideo_trash_purged_total`).

**12. Garbage collection on a schedule** (M, measured: not needed) — GC runs only on request, so coalesced tips and objects of failed
commits pile up as files on the WebDAV server. *How:* a weekly low-priority GC job per project, with the report kept. *Not done:* no collector existed (the design described `POST /api/projects/:id/gc`, never built), and on the demo server nothing piles up: the swimming project's 1,964 objects are all reachable and Ski Fuji has 3 unreachable of 2,390 (0.1 %); at most 31 of the swimming project's 810 media files (16.5 MB of 2.1 GB) are named by neither its documents nor its jobs. A collector's risk (deleting what a lagging listing or an in-flight commit still needs) outweighs that, so the design now says nothing is collected ([garbage collection](design/version-control.md#garbage-collection)).

**13. Warm projects after a restart** (S, done) — after a deploy the first person in pays for the cold caches (items 1–5).
*How:* load the most recently used projects (documents and recent log) in the background at startup. *Done:* the three most recently used projects (kept in `recent-projects.json`) are warmed after a restart, documents and recent log (`rideo_projects_warmed_total`).

## Editor and exports in the browser

**14. Waveforms and filmstrips without downloading the clips** (M, done) — a waveform decodes a clip's whole sound track and
a filmstrip decodes its frames: drawing every lane of the 118-shot cut reads about 400 MB, even now that blocks load
when they come on screen. *How:* the server writes peaks (a few KB) and a thumbnail strip when a take or an
upload is made, as it writes posters; the tab draws those and decodes only media without them. *Done:* a finished take carries its lane files (`media/lanes/<hash12>-peaks.json`, 100 peaks a second, and a filmstrip sprite of a frame a second at 72 px), and the tab draws its waveform and filmstrip from them; it decodes only media without them (uploads, older takes, music and effects) ([waveforms and filmstrips](design/editor.md#waveforms-and-filmstrips)). Uploads stay the tab's, as their posters do: the server never decodes them for editing.

**15. Exports that do not hold every input in memory** (M, done) — an export loads every input as a Blob before its
soundtrack (an ffmpeg export before its first chunk): about 400 MB for the 118 shots. *How:* render the soundtrack chunk by chunk and join the pieces, or load
inputs as each chunk needs them. *Done:* each graph names the media it reads (`ChunkGraph.media`,
`SoundtrackGraph.media`) and the tab loads only those: the ffmpeg engine a chunk's media as it renders it, and the
soundtrack in windows of about 60 s on whole seconds (`planAudioWindows`), each opening the media it plays (13 of a
150 s cut's 31 files, not all of them). `export.finish` joins the pieces (`soundtrack-0001.flac`, …, and the stems'),
and a resumed render starts at the first window not staged ([soundtrack](design/editor.md#soundtrack)). Joined, the
pieces are the whole film's float samples: a native-ffmpeg test with AAC at 44.1 and 32 kHz, WAV at 24 kHz, fades, a
crossfade, a sped-up item and a ducked bed finds the 16-bit samples within one step everywhere (the conversion rounds
under 0.5 % of them the other way). Two causes of seams were found and removed on the way: the resampler `aformat`
inserts for a rate and a layout at once started 0.23 samples off the grid after some seeks (39 steps apart), so a
segment is resampled by an explicit `aresample`; and `atempo` cannot resume mid-stream (a step of 4,002 at a peak of
6,031), so a window never ends inside a sound whose speed is not 1.

**16. Bounded range requests** (S, done) — mediabunny's `UrlSource` asks for open-ended ranges (`bytes=N-`) and aborts once it
has what it needs, but the server and the storage behind it start sending the rest of the file. *How:* a `fetchFn`
that caps each range (say 4 MB) and asks again, so storage reads follow what is decoded. *Done:* the editor's fetch closes each open-ended range at 4 MiB (`cappedRanges`) and mediabunny asks again from where an answer stopped ([media requests](design/engine-performance.md#media-requests)).

**17. HTTP/2 in front of the studio** (S, docs, done) — over HTTP/1.1 a browser opens six connections to a host, and the
editor's media reads may take five of them (the API, heartbeats and an export's inputs share the sixth). *How:*
[deployment](deployment.md) recommends HTTPS with HTTP/2 (Caddy's default) for studios that edit long cuts. *Done:* [deployment](deployment.md#behind-a-reverse-proxy-under-a-subpath) recommends HTTPS with HTTP/2 and says how for Caddy, nginx and Apache httpd.

## AI calls and jobs

**18. Re-check unverified takes when the judge is back** (S–M, done) — when the vision provider stayed down past the
retries, takes stayed `unverified`, and someone overrode them one by one (94 in the demo). `consistency.recheck` judges
them again from their evidence frames, on request (REST, MCP) and when a batch ends
([re-checking](design/character-consistency.md#re-checking-unverified-takes)); a button in the clip view is still to
come.

**19. One retry budget per call** (S, done) — an LLM call made up to 4 times by the task's retries is made again by every
job attempt (`maxAttempts`, 3 by default): up to 12 calls for one task while a provider is down. *How:* no job-level
retry for an LLM error that already used its retries, or a job retry that waits for the provider's `Retry-After`. *Done:* a job retry waits as long as the provider's `Retry-After` asked (up to 10 min), and a run that met a paused endpoint (item 20) neither calls it nor counts against `maxAttempts` ([outages](design/ai-gateway.md#outages)).

**20. A circuit breaker per provider** (S, done) — while most calls to a proxy domain fail with `503`, every job keeps
trying on its own. *How:* pause calls to the domain for a while after a run of failures, and say so in the jobs panel. *Done:* after 6 failures in a row (turned away, timed out, cut off) an endpoint (proxy domain and model) gets no calls for 30 s (`RIDEO_LLM_PAUSE_SEC`), then twice as long after every new failure, up to 5 min; jobs wait for it, checks leave takes unverified, the jobs panel says why a job waits, and `rideo_llm_paused`/`rideo_llm_pauses_total` show it ([outages](design/ai-gateway.md#outages)).

## Observability

**21. Storage latency buckets** (S, done) — `rideo_storage_seconds` ended at 5 s, so on OpenList uploads and retried
requests all landed in `+Inf`. Its buckets now go to 300 s ([observability](design/observability.md#metrics)).

**22. Storage round trips per request** (S, done) — nothing showed how many storage operations a request made. They
are counted per request (`rideo_storage_ops_per_request`) and logged with their time on requests slower than 2 s.

## The panda demo (October 2026, second run)

A ten-minute film of two pandas skiing below Mount Fuji, with B1 dialogue voiced by the video model
(`wan3.0-video-prime` at 1080p), Seedream 5.0 Pro for pictures, `qwen3.8-max` for writing and judging and
`qwen3.8-omni-flash` as the audio-visual model, all through mm-gateway and the overloaded newapi proxy. Fixed while it
ran:

- **Long model calls** (done) — writing the outline and pilot scene of a ten-minute film took more than ten minutes,
  and both mm-gateway's read timeout (600 s, including the wait for headers) and undici's 300 s header timeout cut it
  off twice. OpenAI-compatible calls are streamed now ([long calls](design/ai-gateway.md#proxy-usage-llm-vision-stt-embeddings)).
- **Provider watermarks** (done) — Seedream marked every reference "AI生成" in a corner; Rideo now asks for no visible
  watermark ([provider watermarks](design/provenance.md#provider-watermarks)).
- **Outfits** (done) — the writer split each outfit into single pieces and the references lost the jackets; version 2
  asks for complete outfits ([outfits](design/continuity.md#storytelling)).
- **A take's attempts** (done) — the report counted only the kept candidate's attempt number (1 when all three
  attempts were equally bad), so insights' first-try count and `rideo_take_attempts` understated retries.
- **A race in the direct panel** (done) — a lens and an aperture changed quickly undid each other (CI caught it once
  version 2 plans gave every shot a lens).
- **Figures in location references** (done) — the plush style made the image model put a fox, two bears and a red
  panda on the slopes, and the chairlift's description put pandas in its reference; "reference sheet" painted
  collages. References now ask for one picture with nobody in it ([elements](design/elements.md)). 8 of 26 element
  references and 8 character references were thrown away before that.
- **Output downloads** (done) — on the real-model CI run of October 25 two jobs failed at the same second
  downloading their finished images from the provider's file host (`fetch failed`, not retried), after the images
  were paid for. Downloads are now made up to three times, then fail as a retryable `gateway_error`.
- **A ledger lost on a reload** (done) — a studio reload under load read the usage ledger as missing, and the next
  write replaced $50 of history with a fresh ledger. Unreadable ledgers are no longer written over, a missing file is
  read twice, and a missing ledger is rebuilt from the jobs, which still held all of it
  ([usage ledger](design/observability.md#usage-ledger)).
- **Judge answers that drift** (done) — `qwen3.8-max` now and then named a character instead of giving its id, or
  put a sentence in the list of characters; after the repair round the take stayed unverified. Such verdicts are read
  now, and mm-gateway's 502 for a failed upstream (`generation_service_error`) is retried like its other load
  problems.
- **Characters copied into singles** (done) — the scene reference frame shows the whole cast, and the image model
  put Sammy into Rosie's close-up twice. Version 2 prompts now say who is in frame and who is not
  ([who is in frame](design/continuity.md#prompts-version-2)).

**23. Reasoning off for checks** (S, done) — `qwen3.8-max` reasons at length: a 200-word story took 3,167 completion
tokens and 61 s, and every judge call of the demo about 2,500 output tokens and 60 s, so a take spent two minutes being
judged. On the first 15 takes of the batch (`rideo_shot_step_seconds`, `rideo_llm_call_seconds`) an attempt took
about 330 s: the keyframe 112 s (Seedream 53 s, the rest its judge), the video 107 s and its checks 110 s, with
`consistency.judge` at 78 s a call, so judging was nearly half of it (`sound.check`, 26 s, runs alongside). Planning a
clip took 8.5 minutes a call. Through mm-gateway and newapi, `enable_thinking: false` cut a small scoring task from
12.4 s to 2.4 s (281 reasoning tokens to none). *How:* a reasoning setting per task family: off for checks and captions
(`consistency.judge`, `sound.check`, `frame.caption`), the model's default for writing and feedback; sent as
`enable_thinking: false` (Qwen), `thinkingConfig.thinkingBudget: 0` (Gemini), and dropped for good by an adapter once
its upstream refuses it. Measure the judge's agreement with and without reasoning before turning it off. *Done:* checks and captions answer without reasoning (`enable_thinking: false`, Gemini's `thinkingBudget: 0`, dropped for good by an adapter whose upstream refuses it; `RIDEO_CHECK_REASONING`). Measured on 16 frames of this demo, the judge reached the same pass or fail on every frame with and without reasoning, caught the four bad ones either way, and answered in 8.6 s instead of 57.1 s (median) with 231 output tokens instead of 2,304 ([reasoning](design/ai-gateway.md#reasoning)).

**24. Stream Gemini and Anthropic calls too** (S, done) — only OpenAI-compatible calls are streamed; a long Gemini or
Anthropic answer still ends at the gateway's 600 s. *How:* `streamGenerateContent?alt=sse` and Messages streaming in
their adapters, with the same idle timer. *Done:* Gemini (`streamGenerateContent?alt=sse`) and Anthropic (`stream: true`) calls are streamed with the same idle timeout, each falling back to an unstreamed call for an upstream that refuses it ([long calls](design/ai-gateway.md#proxy-usage-llm-vision-stt-embeddings)).

**25. Video parameters the gateway drops** (S, mm-gateway, done) — its DashScope adapter drops `negative_prompt` for video
and maps no `generate_audio`, so a silent take cannot be asked for and exclusions only work as prompt text (version 2
puts them there). Sources disagree on whether `wan3.0` takes a negative prompt at all. *Done:* mm-gateway sends Wan 3.x the native body (typed `input.media`, `parameters.audio`, the resolution tier, 2–30 s), drops references when a frame is given (the modes are exclusive) and documents Wan 3.0's limits; Rideo sends no references with a frame and no negative prompt to such models.

**26. The provider's prompt rewriting** (S, done) — Wan's `prompt_extend` is on by default: an LLM rewrites the prompt and
may change the lines it should speak, and Wan 2.6 planned multi-shot videos only with it on. The third pass turned it
off together with the prompt change of item 39, so its share of that result is unknown; one of its 13 takes then
spoke an invented Chinese line in a shot without lines (the sound check flagged it). *How:* measure stray cuts and
the lines the sound check hears with `generation.enhancePrompt` off and on, and default to what keeps the words and
the single shot. *Done:* version 2 prompts send `enhance_prompt: false` unless the project asks for the rewriting ([prompt rewriting](design/continuity.md#prompts-version-2)).

**27. A faster judge** (S, done) — a judge call takes 19–23 s through the proxy with any of the vision models tried, more
than the rest of a take's checks together. *How:* a judge model setting apart from vision (a flash model), or all of
a take's frames in one smaller image. *Done* with item 23: a judge call is about 9 s.

**28. A fallback endpoint per task family** (S–M, done) — the newapi proxy answered `503 system cpu overloaded` to every
model for long stretches. *How:* an ordered list of endpoints per family (writing, judging, listening) used in turn,
with the circuit breaker of item 20. *Done:* each family (writing, judging, listening) may have a fallback endpoint on another provider (Settings: *Text model, fallback*, *Vision, fallback*, *Audio-visual model, fallback*); a call goes there when its endpoint is paused or turned it away after its retries (`rideo_llm_fallbacks_total{task}`), never for an invalid answer or a refusal ([fallbacks](design/ai-gateway.md#outages)). The demo server has none configured yet: all three families use the newapi proxy, and a fallback needs another provider's base URL, model and key.

**29. Provider moderation that refuses harmless output** (S, done) — on the real-model CI run of October 25, DashScope ended
the footage analysis of a test pattern with `data_inspection_failed` ("output data may contain inappropriate
content"), streamed as an error event, and the analysis fell back to its rules. *How:* recognize refusals
(`data_inspection_failed`, `content_filter`) as their own error code, make the call once more at a lower temperature,
and count them in `rideo_llm_calls_total{status="refused"}` so a flaky moderator shows on the dashboard. *Done:* a refused call is made once more at temperature 0, then fails as `llm_refused`; both count as `rideo_llm_calls_total{status="refused"}` ([refusals](design/ai-gateway.md#refusals)).

**30. The judge counts who should not be there** (S, done) — the judge scored only the characters a shot lists, so a
frame with an extra cast member passed. With quality checks the judge is now told who must not be in the shot, an
extra fails the frame (keyframes and storyboard frames included), and other figures are reported
([quality checks](design/continuity.md#quality-checks-in-the-gate)).

**31. Keep the video lane full** (S, done) — the batch keeps two clips in flight and each clip makes its first shot alone
(its keyframe is the scene reference of the others), so with eight video slots only five to seven were busy at times.
*How:* a lookahead setting (three clips by default when the lane is wider than a clip's parallel shots), and the next
clip's first shot started while the current clip's others run. *Done:* `settings.batch.lookahead`, three clips in flight by default.

**32. Unattended batches and new elements** (S, done) — the batch stopped at 36 of 110 shots because an extension introduced
a prop ("Resort trail lights") that a person must approve first, as designed; nobody was watching for twenty minutes.
*How:* the Inbox already says so; add a push or webhook notification, and a project setting that approves a new
element's first generated reference for unattended runs (the person reviews it later, the take records it). *Done:* `settings.batch.approveNewElements` (off by default): an unattended batch draws a new place or prop's references, approves the first and locks it as the system, and goes on ([batch generation](design/generation-pipeline.md#batch-generation)).

**33. Job records on a slow WebDAV server** (S, done) — right after a studio reload, OpenList answered `405 Method Not
Allowed` to PUTs of two job records in `.rideo/jobs/`. *How:* retry `405` like other transient answers of that server
(it is not a real refusal there) and keep the record in memory until it is written. *Done:* a buffered file write is tried again on `405` like a `503` ([slow and flaky servers](design/storage-webdav.md#slow-and-flaky-servers)).

**34. Long exports and browser blob memory** (M, done) — the editor tab keeps every rendered chunk as a blob until the film
is joined. In a Chromium context without a disk-backed profile (Playwright's default, and incognito windows) the
ninth minute of a 1080p film ended in `ERR_BLOB_OUT_OF_MEMORY` after chunk 19 of 19, and the render started over;
five such attempts failed the export. A persistent profile, which pages blobs to disk, rendered it. *How:* write
chunks to the origin private file system (OPFS) as they finish, or upload each chunk to the server and join them
there, so memory does not grow with the length of the film; report the browser's storage quota before a long render.
*Measured:* the failed attempt's log shows the soundtrack loading its inputs (`loading media 52/110`) when Chromium
refused the next download, and the soundtrack held every input at once (item 15). That was not all of it. With item
15 deployed, the same film rendered in Playwright's default context (October 29) failed at its soundtrack's second
download (`Failed to fetch`, `soundtrack 1/9: loading media 2/13`) after its 19 chunks: the chunks, about 115 MB each,
were uploaded as Blobs, and an uploaded Blob holds its blob memory until a garbage collection that its size does not
prompt. Its WebCodecs engine also kept every source it had opened, its JavaScript heap growing from about 200 MB to
1.1 GB. Sending the chunks as bytes instead killed the Playwright driver: Chrome copies a body of bytes whole into
the DevTools protocol's request event, and a 130 MB chunk made a message over 512 MB. *Done:* with item 15 the tab
holds one chunk's or one window's media at a time, and the LRU of downloaded media is 512 MB instead of 1 GB; the
WebCodecs engine keeps open only the sources of the chunk it renders (`MediaPool.retain`); and rendered chunks and
pieces are uploaded as bytes in slices of 8 MB, which the server appends and stages when the last arrives
([memory](design/editor.md#memory)). Nothing of a render is stored in the browser, so there is no quota to report.
*Measured with them deployed (October 29):* the same film rendered in Playwright's default context, every Blob in
memory: 19 chunks and 9 soundtrack windows (up to 15 inputs each) in 62 minutes, the JavaScript heap at 599 MB at
its peak (1.1 GB in the failed run, which then grew with every chunk) and back to about 200 MB after each chunk, and
no blob error.

**35. A cast-only film** (S, done) — the brief said "only these two characters appear", yet the export has a
red-haired girl with a snowboard in two shots, a human child in place of a panda in four, a brown bear and a dog
creature: Wan widens a close-up late in the take and fills the new space with figures, and the judge reported
them (`others`) without failing the take. Now `consistency.castOnly` (the project settings' "Only the cast may
appear", off by default; feedback may recommend it) fails such a frame like an extra cast member
([quality checks](design/continuity.md#quality-checks-in-the-gate)). It is also turned on when the brief asks for only
its cast: the writer answers `castOnly` with the screenplay (from the brief's words, in any language) and the
screenplay job sets the setting, so the screenplay review, the storyboard and the first takes are judged with it.

**36. Feedback that sees and hears** (S, done) — the first feedback on the export let `qwen3.8-omni-flash` watch each
scene as one video with its sound. It heard all 61 lines and who said them, but its picture findings were unreliable:
for scene 2 (70 s, 14 shots on the beginner slope) it reported a critical "instant teleportation" for each of shots 2
to 14, back and forth between the lodge and the slope, though only the first shot is near the lodge door. The vision
model reading the frame strips
(three labelled stills a shot) pinned each of its 138 issues to a shot and a moment, and they hold up when checked:
the human child at 85 % of C2·S13, the decals that move from Rosie's skis to Sammy's in C1·S5, the stray cuts inside
nominal single shots. Feedback now always judges the picture from strips and asks the audio-visual model only about
dialogue and sound (`feedback.listen`), both at the same time ([how a film is watched](design/feedback.md#how-a-film-is-watched)).

| Run | Model(s) | Overall | Continuity | Temporal | Character | Issues (critical) |
|---|---|---|---|---|---|---|
| Watched and heard as video | `qwen3.8-omni-flash` | 5.2 | 3 | 5 | 5 | 88 (28, 13 of them the teleports) |
| Strips (picture only) | `qwen3.8-max` | 4.9 | 3 | 3 | 4 | 138 (15) |
| After the fixes of items 39–41: strips, and heard | `qwen3.8-max`, `qwen3.8-omni-flash` | 6.0 | 4 | 4 | 7 | 144 (11; 116 about the picture) |

The second export, after the three passes, scored 6.0 against the 4.9 of the same strip review of the first: the
humans, the bear and the dog are gone (character 4 → 7), editing went from 3 to 5, and the measured stray cuts inside
shots fell from 10 to 3; all 61 lines are still heard. Scores of a model vary from run to run; the cut count is
measured. What it still finds: the chairlift scene (the pair apart on the chair, skis in their paws), inserts that
widen at the end (fixed in the second pass with the earlier prompts), props that change inside a scene (the size
chart's text, poles, decals) and the same 5-second length for every shot.

**37. Music under the takes** (S–M) — `generation.music` off and the version 2 sound line ("no music, no song, no
humming") still left music under 21 of the 110 takes in the cut: 2 of the first 6 takes before that line, about 19
of the 104 after. The sound check hears it, but it is advisory, so a five-second shot with its own tune makes the
cut jump from one tune to the next. *How:* once the gateway passes `negative_prompt` (item 25) put "music" there; a
project setting that retries takes with music like an unheard line (each retry is a paid 5 s take, $1.40 here); or,
better, a source-separation step that keeps voices and effects and drops the music of the takes where it is heard. *Partly done:* `consistency.rejectMusic` (off by default; a toggle in the project settings) fails a take whose sound check hears music, so it is generated again like a take whose line is not heard ([quality checks](design/continuity.md#quality-checks-in-the-gate)); Wan 3.0's own words for no music ("No BGM") are in the sound line since 2e039ff. *Source separation, not needed now:* with that line the sound check heard music in none of the swimming film's 79 takes, and separation needs a model the gateway does not offer (mm-gateway has none; ElevenLabs' voice isolator would drop the effects with the music). Measure again on a film whose takes carry music.

**38. Fixes the feedback cannot see the cost of** (S, done) — the strip review recommended regenerating 68 shots (27 at
priority 1). Applying all of them is at least $100 at this run's prices ($1.45 an attempt), and some shots fail again
for the same reason.
*How:* each recommendation shows its estimated cost (attempts × the take's price, from `RIDEO_PRICES`) and the
feedback panel offers "apply the priority 1 fixes" with the total; the retrospective then compares the scores before
and after the fixes. *Done:* each regenerate or re-plan recommendation carries its estimate (the shot's seconds times the project's mean attempts, priced with the pinned models), and the panel offers *Apply the priority 1 fixes* with their total ([what a fix costs](design/feedback.md#what-a-fix-costs)). Comparing the scores before and after the fixes is the next feedback's job (the Insights view lists each export's).

**39. What the video model reads** (S, done) — the second pass applied the strip review's 27 priority 1 shot
regenerations with `consistency.castOnly` on ($84.52): 14 shots passed every check (11 at the first attempt) and 13
failed all three attempts. The sheets of the failures show where they went: near the end of the take Wan cut or
widened to whatever else the prompt described. Rosie's snowplow stop cut to "Sammy sits in the soft snow", the
previous shot's end state that the prompt carried as `Continues from the previous shot`; her close-up cut to Sammy "in
a low wedge", the same line; Sammy's close-ups gained Rosie, drawn as a human girl in her pink jacket, from the scene
line that describes both outfits. Wan 2.7 and later infer the shot structure from the prompt when it is not stated,
so a single shot's video prompt now opens with it and keeps only this shot: no camera-style list, no previous end
state, no scene continuity when part of the cast is out of frame, and only the names of who is in frame
([what the video model reads](design/continuity.md#what-the-video-model-reads)). Keyframes keep all of it. In the third
pass, with these prompts and the provider's prompt rewriting off (`generation.enhancePrompt: false`, item 26; the two
were changed together), the 13 failed shots were generated again ($33.65): 8 passed at the first attempt and their
sheets show what the fixes asked for (Rosie stays in her shot to the stop, the close-ups hold, no human on the
chairlift), 4 failed only the cast check (item 41) and 1 kept its earlier take.

**40. A fix that fails its checks** (S, done) — a regenerated take replaces the cut's take when its identity passes, even
when its quality checks fail. In the second pass that was right for some shots and wrong for others: the new
take of C5·S9 failed only a jump check but had panda Rosie where the old one had a human child, while the new take of
C4·S13 put a human girl on the chairlift where the old one had a stray cut. *How:* after a fix, the feedback panel
shows each applied recommendation as fixed or not (the new take's checks), with the previous take one click away,
and the next feedback on the export compares the two takes of each fixed shot. *Done:* a fix's take replaces the cut's take only when it passes every check; otherwise the panel says *Not fixed* with the new take's issues and offers **Use the new take** (`take_select` with `inCut`, one commit). The outcome is derived from the documents (`fixOutcome`) ([when a fix does not pass](design/feedback.md#when-a-fix-does-not-pass)). The next feedback compares every shot whose take in the cut changed since the previous one: its issues then and now, weighted by severity, as better, the same or worse, on the document, in the report, in the retrospective (`retake_results`) and on the panel ([what changed since the last feedback](design/feedback.md#what-changed-since-the-last-feedback)).

**41. Who is in frame after a fix** (S, done) — a fix that brings a character into the shot ("put Rosie's head and
pink beanie at frame right") left the shot's cast as planned, so the gate counted that character as an extra: the
other 4 shots of the third pass failed every attempt that way while their takes showed what was asked. A
`regenerate_shot` action now names who is in frame after the change (`characters`), and applying it sets the shot's
cast ([actions](design/feedback.md#actions)).

### Run figures

- **Cost:** $250.74 for the first export of 9 min 11 s (110 shots, 8 scenes): $27.31 a finished minute. 265 of the 840
  generated video seconds were attempts the gate discarded (32 %, about $74). The fixes added $118.17 (40 shots
  regenerated, 27 then 13), so the film cost $370.39 in all, about $40 a finished minute, with 470 of 1,245 video
  seconds discarded (38 %, $131.60).
- **Throughput:** raising `RIDEO_LANES` video from 4 to 8 (the provider allowed it) roughly tripled the rate; the
  batch then finished 28 to 41 shots an hour. Even so shots waited 899 minutes in the queue against 858 running, and
  the slowest tenth took over 13 minutes each (item 31).
- **Export:** 1.05 GB at 1080p, −14.4 LUFS integrated, −1 dB true peak; the editor tab rendered it in 19 chunks once
  it had a disk-backed profile (item 34). The second export took 85 minutes: 49 to render in the tab, 27 to watermark
  on the server, then the upload; its feedback, picture and sound together, 30 minutes more.
- **Flaky test:** `packages/web/test/settings.test.tsx` "never shows a secret" fails now and then in a full unit run
  on a loaded two-core box (once in 42 ms, so an assertion, not a timeout) and passes alone and in loaded reruns; it
  has not failed on CI. Capture its message the next time it fails. *Fixed:* CI caught it on October 28 (`TypeError:
  Cannot read properties of null (reading 'type')` right after *Replace*): the page asks for its settings again every
  2 s while API keys register, and every new answer ended a replacement in progress, so an answer landing at the click
  took the field away, in the studio as in the test. A replacement now ends only when the settings were saved
  (`updatedAt`). It failed again in loaded runs after that (once on CI, blocking an image), and the real cause was the
  field's own: it ended a replacement in an effect keyed on `updatedAt`, which also runs once on mount, and under load
  a quick first click on Replace landed before that mount effect was flushed, so the effect undid it. A replacement
  now ends only when `updatedAt` changes from the value the field saw first.


## The swimming demo (October 28, 2026)

A five-minute film of Sammy and Rosie swimming at a lagoon, made to measure the studio after the work above: the
screenplay and storyboard reviews, Wan 3.0 used as documented, the checks without reasoning, the music option and the
unattended batch. What it taught while it ran:

**42. The screenplay reviewer misread how a film is written** (S, done) — the first review called the 30-second
scenes a critical problem for a model of 2–10 s shots, the second called "only two scenes written" critical; both cost
a revision round (the review passed at its third, 6.4 → 6.8 → 7.5). The reviewer is now told that the planner splits
scenes into shots and that production writes each later scene from its outline beat, and each beat says whether it is
written ([how a review runs](design/ai-review.md#how-a-review-runs)).

**43. Storyboard frames drawn all at once** (S, done) — the storyboard review scored continuity 5 in all three of its
rounds (6.6 → 6.9 → 7.1): the watermelon halves wandered across the beach and onto a blanket, the shoreline and the
sun swapped sides. Each scene's first frame is now drawn first and the others take it as their scene reference, as
the video pass's keyframes do ([storyboard jobs](design/storyboard.md#jobs)).

**44. What the video model reads of a single and of a silent shot** (S, done) — in the pilot, Rosie's close-up said
"turns her eyes to Sammy on the right" and Sammy walked into all three attempts; 5 of the 8 attempts at its silent
shots had speech nobody wrote, under a sound line that named "the characters' voices". A video prompt now calls an
absent character "someone off-screen", the planner names only who is in frame, and a silent shot's sound line says
nobody speaks ([prompts](design/continuity.md#prompts-version-2)).

**45. A provider at its concurrency limit** (S, done) — the ctaigw aggregator turned away 4 of the pilot's 7
concurrent Wan 3.0 creates (`429 model_concurrency_limit`), and one shot failed all three runs of its job, 2 s and
4 s apart. A `429` to a create made no task, so the call now waits and asks again (15 s doubling to 60 s, up to 10
minutes) ([a busy provider](design/ai-gateway.md#sdk-usage)); until it was deployed the video lane ran at 3.

**46. The film's style named another scene's light** (S, done) — the writer put "a warm orange sunset glow in the
final scenes" into the film-wide lighting (and "warm orange sunset light" into the palette), every video prompt carried
it, and 4 of the pilot's 8 morning takes ended at sunset. A video that starts from a frame now leaves the style's
palette and lighting out (the frame shows them, the scene line gives the time of day), and the writer keeps times of
day out of the style ([what the video model reads](design/continuity.md#prompts-version-2)).

**47. Anything shown twice** (S, done) — the first export's feedback (6.2) listed 6 critical issues, most of them
inside single takes the gate had passed: a second Rosie popping in, two yellow swim boards, ghost double exposures with
a duplicated ball. The judge samples the same three moments (15, 50 and 85 %) the feedback's strips show, so it saw
those frames, but it could only report cast members who should not be in the shot and other figures. It now lists
anyone or anything shown twice, a see-through ghost included (`duplicates`), and such a take fails its quality checks
and is generated again ([quality checks](design/continuity.md#quality-checks-in-the-gate)).

**48. Feedback that called the edit's dissolves ghosts** (S, done) — after 23 priority 1 fixes, each of which passed
every check and went into the cut, the second feedback still scored 6.2 and called two scene exits critical "ghost
double exposures", both shots just regenerated without ghosts. Its strips sampled 85% of short last shots inside the
0.5 s crossfade into the next scene, where the cut blends two shots. A strip now samples each shot's clean part,
without its own transition or the next one's ([how a film is watched](design/feedback.md#how-a-film-is-watched)).

**49. A provider that refuses its own output** (S, done) — on the real-model CI run of October 28 Volcengine refused
a cartoon panda's reference sheet (`400 OutputImageSensitiveContentDetected`) and the job failed at once; retrying the
job would not have helped, since mm-gateway answers a reused idempotency key with the failed task it stored. *Done:*
a task refused for its output is asked for again as a new task with another seed, up to two more times, then fails as
`output_refused` ([a refused output](design/ai-gateway.md#sdk-usage)).

**50. Voiced scenes rendered as sequences** (M, done) — continuity stays at 4 (see *What is left* below) because every shot is
a generation of its own: the ball, the board and the light are drawn again at each cut. Wan 3.0 renders up to 8 shots
of 2–5 s in one request ([multi-shot](design/multi-shot.md)), but Rideo renders sequences only for silent takes
without quality checks, so a voiced, checked film such as the swimming one never uses them. Eight of its ten scenes
are runs of 4–8 such shots (two characters, every shot at most 5 s). *Measured:* one voiced Wan 3.0 sequence of scene
7's shots 2–6 (17 s, 5 lines; the prompt compiled by `compileMultiShotRequest` with sound on, from shot 2's verified
keyframe; $4.76, rendered in 195 s): 4 hard cuts detected at 3.3, 8.1, 10.5 and 14.2 s (planned 3, 7, 10, 14); the
pandas' outfits, the light, the beach, the ball and the board the same in every shot; and the omni model heard all 5
lines word for word, each inside its own shot, in the right voice (Rosie female, Sammy male), said by the character
on screen (lip sync 0.9), with no music. *How:* render voiced, quality-checked runs as sequences: the request with
sound, each segment cut with its sound and checked like a single take (identity, physics and the cast from the judge,
its own jumps, its lines heard), and a shot whose segment fails made again alone. *Done:* voiced, checked runs render as sequences
([splitting and verification](design/multi-shot.md#splitting-and-verification)): the request carries the takes' sound,
each segment keeps its part of it and is checked like a single take, a render whose segments all pass is used whole,
and a voiced or checked group is rendered once, its failing shots made again alone (a new take replaces the segment
only when it passes). On the way, the split at the detected cuts was found to end a take on one frame of the next
shot: a cut's time is its new shot's first frame rounded to the millisecond, so segments now end half a frame
earlier. *Measured on the swimming film (October 29):* scene 7 made again on a branch was planned
for single takes, as six shots of up to 6 s, four of them single takes (longer than 5 s, or opening on one panda): one
sequence of two shots formed, and the scene review watched 6.8 against main's 6.6 (continuity 5 against 4) — too
little of it was a sequence to say more, and the same takes watched twice differ by up to 0.7. So the plan is now
made for sequences when the model renders them ([planning for sequences](design/multi-shot.md#planning-for-sequences)):
shots of 2–5 s, the scene opening on its whole cast. Made again with that plan (a second branch, the scene review
watching only), scene 7 became eight shots of 30 s in one sequence: six segments passed every check and two were
made again alone, in 30 minutes (the eight segments are checked one after another; single takes took 16). The
review watched 6.8 again, continuity 5 (main: 6.6 and 4) and character 8, with 11 issues and none critical (main: 8,
one critical). In its frames the six segments of the sequence keep the water, the light, the palms and the ball; the
two breaks the review named most ("sunset light inside a morning scene", "unestablished rocks") are the two shots
made again alone. So the sequence holds a scene together, and its single remakes are where it comes apart again.
Since then a failing segment's shot is made again from the segment's own first frame (the sequence's light, water and
props; a new keyframe only when its identity failed), and a sequence's segments are checked four at a time.

### Run figures

- **Time:** brief to first export in 6 hours, 99 minutes of which the batch was held while items 44–46 were made
  and deployed; without the hold, about 4.4 hours. Screenplay and its review: 41 min (three rounds). Cast: 7 min.
  Storyboard and its reviews: 59 min (three rounds, then three priority 1 redraws and a re-review). Pilot: 29 min.
  Batch: 78 min (71 shots in 8 clips; scenes 3–10 written on the way). Export: 46 min (28.5 min rendering in the tab,
  17 finishing). Feedback: 20 min.
- **Generation:** with items 44–46 deployed, 67 of the batch's 71 shots passed every check at the first attempt
  (94 %, mean 1.07 attempts; about 60 % in the panda demo). That took 289 s of video for 270 s of film, and no take had
  music. The pilot, on the earlier prompts: 3 of 8 at the first attempt. Every scripted line was heard in every take.
- **Feedback:** the first export scored 6.2 (the panda demo's first 4.9, its third 6.0). Dialogue 8.9, sound 9.4,
  storytelling 7, character 7, continuity 4, temporal 5. 121 issues: 6 critical, most of them duplicates the gate
  could not report (item 47). The 23 priority 1 fixes all passed every check and replaced their takes, 16 at the first
  attempt; they cost $34.09 against an estimate of $28.33. The second export, re-watched with clean strips (item 48),
  scored 6.5: character 8, editing 6, physics 6, realism 7, critical issues 3. Continuity (4) and temporal (5) did not
  move.
- **Cost:** $134.62 to the first export, $27.11 a finished minute; the batch alone was $18.82 a minute against the
  panda demo's $27.31. With the fixes and three feedbacks, $169.55. Wan 3.0 was $125.44 of the first $134.62.
- **What is left:** continuity across shots. Props change side, count or state between cuts (the ball, the board,
  the watermelon), and the sun moves. The gate judges one take at a time and the storyboard reference fixes only the
  frames, so the feedback's continuity stays at 4. Next: a scene check after a clip is generated, with strips of all its
  shots as the feedback has them, and its fixes made before the edit. *Done:* `clip.review` watches each scene's
  selected takes with the export feedback's own scene call when the clip is made, applies its priority 1
  regenerations (at most `settings.review.sceneFixes`, 3 by default; a new take is selected only when it passes every
  check) and watches the scene again; the batch assembles the cut from the fixed takes
  ([scenes before the edit](design/ai-review.md#scenes-before-the-edit)). Watching only, on the swimming film's
  takes (10 vision calls, 350 s for the ten scenes at once), it saw what the export feedback saw: each scene's
  overall within 0.7 of the export's, continuity 4–5 against 4, and 34 priority 1 regenerations against the
  feedback's 24 (continuity 51 of the 99 issues, temporal 14, physics 12). With its fixes, on the two weakest
  scenes ($12.35, 18 minutes): scene 10 went from 6.6 to 7.5 (continuity 4 → 6, issues 11 → 7) with one of its two
  fixes passing; scene 5 stayed at 5.9 → 5.6 (continuity 4, issues 11) with one of three. The same takes watched twice
  scored up to 0.7 apart, so one scene's change is noisy. Two of the five fixes failed while the newapi proxy answered
  `502` to the judge and the listener: both endpoints paused and the takes stayed unverified, which a fix counts as not
  passing (item 28).
