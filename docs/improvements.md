# Improvements: what the demos taught us

The ten-minute demo of October 2026 (the story *Bao and Mei Learn to Surf*: 20 clips, 118 shots, a 9:45 export, then a
footage edit of that export) ran on a studio whose WebDAV server is OpenList over a cloud drive, where every request
takes 1.3–2 s, with an upstream LLM provider that was overloaded at times. What broke in it is fixed: slow saves and
false 404s ([slow and flaky servers](design/storage-webdav.md#slow-and-flaky-servers)), an editor tab that lost its
export ([editor jobs](design/editor.md#editor-jobs), [media requests](design/engine-performance.md#media-requests)),
LLM calls turned away for load ([structured tasks](design/ai-gateway.md#structured-tasks)) and projects that could not
be deleted. This page lists what can still improve. Each item gives the evidence, how it fits Rideo, and a rough
effort (S ≤ 1 week, M 1–3 weeks, L > 3 weeks for one engineer), like the [roadmap](roadmap.md).

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
| Uploading the 419 MB export to WebDAV (export finishing) | about 6 min |
| Overriding the consistency check of 94 takes | one commit each (about 20 min before the fixes) |

## Storage and version control

**1. Pages wait for history on a cold start** (S) — the project store loads `/state` and `/history?limit=100`
together and shows nothing until both answer (`web/src/store/project.ts`), and the first history after a restart took
26.5 s. *How:* render from `/state` and fetch history in the background; on the server, read the recent log into the
commit cache when a project loads.

**2. A recent-log file per branch** (M) — a log walk reads one commit object at a time (a commit names its parent, so
the next read waits for the last), so 100 commits cost 100 round trips on a cold cache. *How:*
`.rideo/logs/<branch>.json` with the last 200 commit summaries, written behind the commit like the work tree; a cache,
rebuilt from the objects when it is missing or behind the ref.

**3. The project list and the Inbox from summaries** (M) — `GET /api/projects` and `GET /api/inbox` load every
project's whole document set, one project after another, walk its log, and list the projects folder on every call
(15 s and 18–38 s cold). *How:* a per-project summary (title, stage, durations, poster, open reviews, the gate to
approve, recent agent commits) kept in memory and in `.rideo/summary.json` behind the commits; projects read in
parallel; the folder listing cached and refreshed on create, delete and import.

**4. One commit for many changes** (S–M) — a save is still two round trips (about 4–5 s on OpenList), and the demo made
one commit per take override (94) and per editor operation. *How:* approve and override many takes in one call (REST
and MCP); the editor sends its queued edits as one request when several wait ("Saving N edits…"); on the server,
transactions waiting on the project lock committed together.

**5. Exports ready before the WebDAV upload ends** (M) — export finishing uploads the watermarked file to WebDAV before
the export is ready: about 6 minutes for 419 MB. *How:* ready once the file is in the local media cache (served from
there), uploaded in the background with retries, the export card saying so until the file is on WebDAV.

**6. ETags from PUT answers** (S) — every work-tree batch lists each folder it wrote to, only to learn the new etags.
*How:* take the ETag from the PUT answer when the server sends one (the `webdav` client's `putFileContents` does not
return headers; a custom request does).

**7. Media reads that survive a hiccup** (S) — `readStream` retries its `stat` but not the stream itself, so a `500`
from OpenList at the start of a media read reaches the browser. *How:* retry the GET until its first byte arrives.

**8. Projects deleted outside Rideo** (S) — a project is looked up once per process; sync's `verify` notices a deleted
folder, but sync runs only for projects with live subscribers, so a folder deleted over WebDAV stays served from
memory until a restart. *How:* drop project handles left idle for a while, or verify loaded projects on a slow timer.

**9. Emptying the WebDAV trash** (S) — `trash/`, and `projects/<id>.trashed-<time>` on servers that cannot move a
folder into another, are never emptied (a browser's trash is emptied after 7 days). *How:* a scheduled purge after
7 days, with a metric and a log line per project removed.

**10. Garbage collection on a schedule** (M) — GC runs only on request, so coalesced tips and objects of failed
commits pile up as files on the WebDAV server. *How:* a weekly low-priority GC job per project, with the report kept.

**11. Warm projects after a restart** (S) — after a deploy the first person in pays for the cold caches (items 1–3).
*How:* load the most recently used projects (documents and recent log) in the background at startup.

## Editor and exports in the browser

**12. Waveforms and filmstrips without downloading the clips** (M) — a waveform decodes a clip's whole sound track and
a filmstrip decodes its frames: drawing every lane of the 118-shot cut reads about 400 MB, even now that blocks load
when they come on screen. *How:* the server writes peaks (a few KB) and a thumbnail strip when a take or an
upload is made, as it writes posters; the tab draws those and decodes only media without them.

**13. Exports that do not hold every input in memory** (M) — an export loads every input as a Blob before its
soundtrack (an ffmpeg export before its first chunk): about 400 MB for the 118 shots. *How:* render the soundtrack chunk by chunk and join the pieces, or load
inputs as each chunk needs them.

**14. Bounded range requests** (S) — mediabunny's `UrlSource` asks for open-ended ranges (`bytes=N-`) and aborts once it
has what it needs, but the server and the storage behind it start sending the rest of the file. *How:* a `fetchFn`
that caps each range (say 4 MB) and asks again, so storage reads follow what is decoded.

**15. HTTP/2 in front of the studio** (S, docs) — over HTTP/1.1 a browser opens six connections to a host, and the
editor's media reads may take five of them (the API, heartbeats and an export's inputs share the sixth). *How:*
[deployment](deployment.md) recommends HTTPS with HTTP/2 (Caddy's default) for studios that edit long cuts.

## AI calls and jobs

**16. Re-check unverified takes when the judge is back** (S–M) — when the vision provider stays down past the retries,
takes stay `unverified`, and someone overrides them one by one (94 in the demo). *How:* a `consistency.recheck` job
over a clip's unverified takes, started when judge calls succeed again and on demand (clip view, MCP).

**17. One retry budget per call** (S) — an LLM call made up to 4 times by the task's retries is made again by every
job attempt (`maxAttempts`, 3 by default): up to 12 calls for one task while a provider is down. *How:* no job-level
retry for an LLM error that already used its retries, or a job retry that waits for the provider's `Retry-After`.

**18. A circuit breaker per provider** (S) — while most calls to a proxy domain fail with `503`, every job keeps
trying on its own. *How:* pause calls to the domain for a while after a run of failures, and say so in the jobs panel.

## Observability

**19. Storage latency buckets** (S) — `rideo_storage_seconds` ends at 5 s, so on OpenList uploads and retried requests
all land in `+Inf`. *How:* add 10, 30, 60 and 300 s.

**20. Storage round trips per request** (S) — nothing shows how many storage operations a request made, so a
per-request lookup (like the existence check fixed above) shows up in a demo, not in the logs. *How:* count storage
operations per request and log them (with their time) on slow requests.
