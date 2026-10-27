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

**1. A project loaded once, not once per request** (S) — after a restart, requests that arrive together (a page's
`/state` and `/history`, the Inbox, the project list, sync) each load the same project's whole document set:
`Repository.state()` does not share a load in progress. After the redeploy of 25 October, while the 118-shot project
was loaded by several requests at once, 66 storage reads gave up (17 answered `500`, 15 `503`, 34 a false `404`) and a
project create answered `503`. *How:* the requests share the load in progress (one promise per branch).

**2. Bounded parallel reads when a project loads** (S) — a project's documents are read all at once (one `Promise.all`
over about 150 objects for the 118-shot project). OpenList answers such bursts with `500`, `503` and false `404`s, and
the retries add to the burst. *How:* read at most 8–16 objects at a time, as a commit writes at most 8.

**3. Pages wait for history on a cold start** (S) — the project store loads `/state` and `/history?limit=100`
together and shows nothing until both answer (`web/src/store/project.ts`), and the first history after a restart took
26.5 s. *How:* render from `/state` and fetch history in the background; on the server, read the recent log into the
commit cache when a project loads.

**4. A recent-log file per branch** (M) — a log walk reads one commit object at a time (a commit names its parent, so
the next read waits for the last), so 100 commits cost 100 round trips on a cold cache. *How:*
`.rideo/logs/<branch>.json` with the last 200 commit summaries, written behind the commit like the work tree; a cache,
rebuilt from the objects when it is missing or behind the ref.

**5. The project list and the Inbox from summaries** (M) — `GET /api/projects` and `GET /api/inbox` load every
project's whole document set, one project after another, walk its log, and list the projects folder on every call
(15 s and 18–38 s cold). *How:* a per-project summary (title, stage, durations, poster, open reviews, the gate to
approve, recent agent commits) kept in memory and in `.rideo/summary.json` behind the commits; projects read in
parallel; the folder listing cached and refreshed on create, delete and import.

**6. One commit for many changes** (S–M) — a save is still two round trips (about 4–5 s on OpenList), and the demo made
one commit per take override (94) and per editor operation. *How:* approve and override many takes in one call (REST
and MCP); the editor sends its queued edits as one request when several wait ("Saving N edits…"); on the server,
transactions waiting on the project lock committed together.

**7. Exports ready before the WebDAV upload ends** (M) — export finishing uploads the watermarked file to WebDAV before
the export is ready: about 6 minutes for 419 MB. *How:* ready once the file is in the local media cache (served from
there), uploaded in the background with retries, the export card saying so until the file is on WebDAV.

**8. ETags from PUT answers** (S) — every work-tree batch lists each folder it wrote to, only to learn the new etags.
*How:* take the ETag from the PUT answer when the server sends one (the `webdav` client's `putFileContents` does not
return headers; a custom request does).

**9. Media reads that survive a hiccup** (S) — `readStream` retries its `stat` but not the stream itself, so a `500`
from OpenList at the start of a media read reaches the browser. *How:* retry the GET until its first byte arrives.

**10. Projects deleted outside Rideo** (S) — a project is looked up once per process; sync's `verify` notices a deleted
folder, but sync runs only for projects with live subscribers, so a folder deleted over WebDAV stays served from
memory until a restart. *How:* drop project handles left idle for a while, or verify loaded projects on a slow timer.

**11. Emptying the WebDAV trash** (S) — `trash/`, and `projects/<id>.trashed-<time>` on servers that cannot move a
folder into another, are never emptied (a browser's trash is emptied after 7 days). *How:* a scheduled purge after
7 days, with a metric and a log line per project removed.

**12. Garbage collection on a schedule** (M) — GC runs only on request, so coalesced tips and objects of failed
commits pile up as files on the WebDAV server. *How:* a weekly low-priority GC job per project, with the report kept.

**13. Warm projects after a restart** (S) — after a deploy the first person in pays for the cold caches (items 1–5).
*How:* load the most recently used projects (documents and recent log) in the background at startup.

## Editor and exports in the browser

**14. Waveforms and filmstrips without downloading the clips** (M) — a waveform decodes a clip's whole sound track and
a filmstrip decodes its frames: drawing every lane of the 118-shot cut reads about 400 MB, even now that blocks load
when they come on screen. *How:* the server writes peaks (a few KB) and a thumbnail strip when a take or an
upload is made, as it writes posters; the tab draws those and decodes only media without them.

**15. Exports that do not hold every input in memory** (M) — an export loads every input as a Blob before its
soundtrack (an ffmpeg export before its first chunk): about 400 MB for the 118 shots. *How:* render the soundtrack chunk by chunk and join the pieces, or load
inputs as each chunk needs them.

**16. Bounded range requests** (S) — mediabunny's `UrlSource` asks for open-ended ranges (`bytes=N-`) and aborts once it
has what it needs, but the server and the storage behind it start sending the rest of the file. *How:* a `fetchFn`
that caps each range (say 4 MB) and asks again, so storage reads follow what is decoded.

**17. HTTP/2 in front of the studio** (S, docs) — over HTTP/1.1 a browser opens six connections to a host, and the
editor's media reads may take five of them (the API, heartbeats and an export's inputs share the sixth). *How:*
[deployment](deployment.md) recommends HTTPS with HTTP/2 (Caddy's default) for studios that edit long cuts.

## AI calls and jobs

**18. Re-check unverified takes when the judge is back** (S–M, done) — when the vision provider stayed down past the
retries, takes stayed `unverified`, and someone overrode them one by one (94 in the demo). `consistency.recheck` judges
them again from their evidence frames, on request (REST, MCP) and when a batch ends
([re-checking](design/character-consistency.md#re-checking-unverified-takes)); a button in the clip view is still to
come.

**19. One retry budget per call** (S) — an LLM call made up to 4 times by the task's retries is made again by every
job attempt (`maxAttempts`, 3 by default): up to 12 calls for one task while a provider is down. *How:* no job-level
retry for an LLM error that already used its retries, or a job retry that waits for the provider's `Retry-After`.

**20. A circuit breaker per provider** (S) — while most calls to a proxy domain fail with `503`, every job keeps
trying on its own. *How:* pause calls to the domain for a while after a run of failures, and say so in the jobs panel.

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

**23. Reasoning off for checks** (S) — `qwen3.8-max` reasons at length: a 200-word story took 3,167 completion
tokens and 61 s, and every judge call of the demo about 2,500 output tokens and 60 s, so a take spent two minutes being
judged. On the first 15 takes of the batch (`rideo_shot_step_seconds`, `rideo_llm_call_seconds`) an attempt took
about 330 s: the keyframe 112 s (Seedream 53 s, the rest its judge), the video 107 s and its checks 110 s, with
`consistency.judge` at 78 s a call, so judging was nearly half of it (`sound.check`, 26 s, runs alongside). Planning a
clip took 8.5 minutes a call. Through mm-gateway and newapi, `enable_thinking: false` cut a small scoring task from
12.4 s to 2.4 s (281 reasoning tokens to none). *How:* a reasoning setting per task family: off for checks and captions
(`consistency.judge`, `sound.check`, `frame.caption`), the model's default for writing and feedback; sent as
`enable_thinking: false` (Qwen), `thinkingConfig.thinkingBudget: 0` (Gemini), and dropped for good by an adapter once
its upstream refuses it. Measure the judge's agreement with and without reasoning before turning it off.

**24. Stream Gemini and Anthropic calls too** (S) — only OpenAI-compatible calls are streamed; a long Gemini or
Anthropic answer still ends at the gateway's 600 s. *How:* `streamGenerateContent?alt=sse` and Messages streaming in
their adapters, with the same idle timer.

**25. Video parameters the gateway drops** (S, mm-gateway) — its DashScope adapter drops `negative_prompt` for video
and maps no `generate_audio`, so a silent take cannot be asked for and exclusions only work as prompt text (version 2
puts them there). Sources disagree on whether `wan3.0` takes a negative prompt at all.

**26. The provider's prompt rewriting** (S) — Wan's `prompt_extend` is on by default: an LLM rewrites the prompt and
may change the lines it should speak, and Wan 2.6 planned multi-shot videos only with it on. The third pass turned it
off together with the prompt change of item 39, so its share of that result is unknown; one of its 13 takes then
spoke an invented Chinese line in a shot without lines (the sound check flagged it). *How:* measure stray cuts and
the lines the sound check hears with `generation.enhancePrompt` off and on, and default to what keeps the words and
the single shot.

**27. A faster judge** (S) — a judge call takes 19–23 s through the proxy with any of the vision models tried, more
than the rest of a take's checks together. *How:* a judge model setting apart from vision (a flash model), or all of
a take's frames in one smaller image.

**28. A fallback endpoint per task family** (S–M) — the newapi proxy answered `503 system cpu overloaded` to every
model for long stretches. *How:* an ordered list of endpoints per family (writing, judging, listening) used in turn,
with the circuit breaker of item 20.

**29. Provider moderation that refuses harmless output** (S) — on the real-model CI run of October 25, DashScope ended
the footage analysis of a test pattern with `data_inspection_failed` ("output data may contain inappropriate
content"), streamed as an error event, and the analysis fell back to its rules. *How:* recognize refusals
(`data_inspection_failed`, `content_filter`) as their own error code, make the call once more at a lower temperature,
and count them in `rideo_llm_calls_total{status="refused"}` so a flaky moderator shows on the dashboard.

**30. The judge counts who should not be there** (S, done) — the judge scored only the characters a shot lists, so a
frame with an extra cast member passed. With quality checks the judge is now told who must not be in the shot, an
extra fails the frame (keyframes and storyboard frames included), and other figures are reported
([quality checks](design/continuity.md#quality-checks-in-the-gate)).

**31. Keep the video lane full** (S) — the batch keeps two clips in flight and each clip makes its first shot alone
(its keyframe is the scene reference of the others), so with eight video slots only five to seven were busy at times.
*How:* a lookahead setting (three clips by default when the lane is wider than a clip's parallel shots), and the next
clip's first shot started while the current clip's others run.

**32. Unattended batches and new elements** (S) — the batch stopped at 36 of 110 shots because an extension introduced
a prop ("Resort trail lights") that a person must approve first, as designed; nobody was watching for twenty minutes.
*How:* the Inbox already says so; add a push or webhook notification, and a project setting that approves a new
element's first generated reference for unattended runs (the person reviews it later, the take records it).

**33. Job records on a slow WebDAV server** (S) — right after a studio reload, OpenList answered `405 Method Not
Allowed` to PUTs of two job records in `.rideo/jobs/`. *How:* retry `405` like other transient answers of that server
(it is not a real refusal there) and keep the record in memory until it is written.

**34. Long exports and browser blob memory** (M) — the editor tab keeps every rendered chunk as a blob until the film
is joined. In a Chromium context without a disk-backed profile (Playwright's default, and incognito windows) the
ninth minute of a 1080p film ended in `ERR_BLOB_OUT_OF_MEMORY` after chunk 19 of 19, and the render started over;
five such attempts failed the export. A persistent profile, which pages blobs to disk, rendered it. *How:* write
chunks to the origin private file system (OPFS) as they finish, or upload each chunk to the server and join them
there, so memory does not grow with the length of the film; report the browser's storage quota before a long render.

**35. A cast-only film** (S, done) — the brief said "only these two characters appear", yet the export has a
red-haired girl with a snowboard in two shots, a human child in place of a panda in four, a brown bear and a dog
creature: Wan widens a close-up late in the take and fills the new space with figures, and the judge reported
them (`others`) without failing the take. Now `consistency.castOnly` (the project settings' "Only the cast may
appear", off by default; feedback may recommend it) fails such a frame like an extra cast member
([quality checks](design/continuity.md#quality-checks-in-the-gate)). Still open: turning it on when the brief asks for
only its cast.

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
better, a source-separation step that keeps voices and effects and drops the music of the takes where it is heard.

**38. Fixes the feedback cannot see the cost of** (S) — the strip review recommended regenerating 68 shots (27 at
priority 1). Applying all of them is at least $100 at this run's prices ($1.45 an attempt), and some shots fail again
for the same reason.
*How:* each recommendation shows its estimated cost (attempts × the take's price, from `RIDEO_PRICES`) and the
feedback panel offers "apply the priority 1 fixes" with the total; the retrospective then compares the scores before
and after the fixes.

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

**40. A fix that fails its checks** (S) — a regenerated take replaces the cut's take when its identity passes, even
when its quality checks fail. In the second pass that was right for some shots and wrong for others: the new
take of C5·S9 failed only a jump check but had panda Rosie where the old one had a human child, while the new take of
C4·S13 put a human girl on the chairlift where the old one had a stray cut. *How:* after a fix, the feedback panel
shows each applied recommendation as fixed or not (the new take's checks), with the previous take one click away,
and the next feedback on the export compares the two takes of each fixed shot.

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
  has not failed on CI. Capture its message the next time it fails.

