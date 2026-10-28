# Storage: assets on WebDAV

Every byte Rideo persists (documents, media, version history, job records, the watermark registry) lives on
a **WebDAV** server. Rideo talks WebDAV even to its own embedded server, so the external and embedded setups
exercise one code path. When no WebDAV server is configured, projects live in the browsers that made them
instead ([browser storage](browser-storage.md)); `RIDEO_STORAGE` (or Settings → Storage) chooses.

| `RIDEO_STORAGE` | Projects | Studio-wide data (accounts, brand kits, recipes, watermark registry) |
|---|---|---|
| `webdav` | the external WebDAV server | the same server |
| `embedded` | the built-in server at `/dav` (`<dataDir>/dav`) | the same server |
| `browser` | each person's browser (IndexedDB) | `<dataDir>/dav`, through an `FsBackend` (not served at `/dav`) |
| `auto` (default) | `webdav` with a URL; `embedded` when the built-in store already holds projects; else `browser` | |

## Backends

```ts
interface StorageBackend {
  read(path: string): Promise<Buffer | null>;
  readStream(path: string, range?: { start: number; end?: number }): Promise<ReadResult | null>;
  write(path: string, data: Buffer | string | Readable, opts?: WriteOptions): Promise<{ etag?: string }>;
  stat(path: string): Promise<Stat | null>;          // { size, etag?, mtime, isDir }
  list(dir: string): Promise<Entry[]>;              // depth 1
  delete(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  capabilities(): Promise<{ conditionalWrites: boolean }>;
}
type WriteOptions = { ifMatch?: string; ifNoneMatch?: '*'; contentType?: string; size?: number };
```

| Implementation | Use |
|---|---|
| `WebDavBackend` | Production. Wraps the `webdav` client. It creates parent collections on demand (MKCOL, with a known-directory cache; concurrent writes into a new folder share one MKCOL), streams uploads and downloads, forwards `Range`, sends `If-Match` / `If-None-Match` when the server supports them, and tries transient failures again ([slow and flaky servers](#slow-and-flaky-servers)). |
| `MemoryBackend` | Unit tests. Same semantics, including conditional writes. |
| `FsBackend` | A local directory: studio-wide data when projects live in browsers ([browser storage](browser-storage.md#fsbackend)). |
| `WorkspaceStorage` | One browser's projects, every operation a round trip to one of its tabs ([browser storage](browser-storage.md#the-protocol)). |
| `RoutedStorage` | Browser mode: project folders to their workspace, everything else to the `FsBackend`, the project listing as the union ([routing](browser-storage.md#routing-on-the-server)). |

`capabilities()` probes once per process. It writes a probe file twice with `If-None-Match: *`; a `412` on the
second write means the server honours preconditions (Apache mod_dav, Nextcloud and rclone do; the embedded
`webdav-server` does not). Either way, every project write goes through an in-process **per-project mutex**,
which is correct for one Rideo instance per WebDAV root. Conditional writes add protection against other
writers.

## Slow and flaky servers

A WebDAV server in front of cloud storage (OpenList on a cloud drive) can take over a second per request, and under
load it answers `423 Locked`, `5xx`, or even `404` for files it holds. Rideo keeps the number of round trips on the
paths people wait for small, and does not let one bad answer become an error:

| Concern | Rule |
|---|---|
| Transient failures | `423`, `429`, `500`, `502`, `503`, `504` and dropped connections (`ECONNRESET`, `ETIMEDOUT`, …) are tried up to 4 more times, waiting 250 ms, then doubling up to 4 s, with jitter. A `Retry-After` is honoured (up to 10 s). |
| What may repeat | Reads, listings, `stat`, deletes, MKCOL and writes of a buffered body repeat on any of them. A conditional write and a MOVE repeat only on answers that say the server did not apply them (`423`, `429`, `503`). A streamed upload is never sent twice. A write of a buffered file also repeats on `405`: a file PUT is never a method a WebDAV server forbids, and OpenList answered it to job records while it was flooded after a restart. |
| False `404`s | A file this process wrote or read, and has not deleted or moved since, is believed to exist (the last 50 000 paths). A `404` for it is tried again like a `503` before it is believed. |
| Media reads | A ranged read (`readStream`) is tried again until its first byte arrives, like any read: a `500` at the start of a GET used to reach the browser as a broken response. An error after the first byte still ends the response. |
| Project existence | A project's `.rideo/HEAD` is looked up once per process, not on every request (a project kept in a browser is still asked every time: that is how a closed browser is noticed). A `404` for it is looked up again 1 s later before the project counts as gone. Projects deleted through Rideo are forgotten at once; sync (`verify`) looks again, so a folder deleted outside Rideo is noticed. |
| Commits | The objects of a commit are written concurrently (up to 8), then the ref: two round trips ([commit protocol](version-control.md#commit-protocol)). |
| Loading a project | One load per branch at a time: requests that arrive while a project loads (a page's `/state` and `/history`, the Inbox, the project list, sync) wait for the same load instead of each reading every document. The documents are read at most 12 at a time. After the redeploy of 25 October several requests loading the 118-shot project at once, each reading its ~150 objects in one burst, made 66 reads give up (`500`, `503`, false `404`s). |
| The project list and the Inbox | Read from each project's **summary**, not from every document: the title, kind, stage and durations, the poster, who may see it, the gate to approve, the open reviews and the agents' commits of the last day. A loaded project's summary is kept in memory and follows its commits; `.rideo/summary.json` is rewritten a few seconds after a burst of commits, like the work tree. A summary read from the file is checked against the branch's tip (one small read) and rebuilt from the documents when it is missing or behind. Projects are read 8 at a time, and the projects folder listing is reused for a minute on WebDAV (creating, deleting or importing a project refreshes it; a browser's listing changes as its tabs connect, so it is not reused). `rideo_project_digests_total{source}` counts the summaries read from their file and those made again. Before, `GET /api/projects` loaded every project's documents one project after another and the Inbox did the same and walked each log: 32.9 s and 103.9 s cold after a restart on the demo server's nine projects (October 28). |
| Work tree | Written behind the commits ([external edits](#external-edits)). |
| Job records | One write at a time per job; a newer state waits for the write in flight instead of racing it (which OpenList answers with `423 Locked`). |
| Deleted projects | Moved to `trash/`. OpenList on some cloud drives renames within a folder but answers `500` to a move into another: then the project folder is renamed where it is, to `projects/<id>.trashed-<time>`, which Rideo does not list (logged as `project renamed in place: the storage cannot move it to the trash`). |

`rideo_storage_retries_total{op,reason}` counts the retries (`reason`: the status, the connection error code, or
`missing` for a false `404`); a request that still fails is logged (`WebDAV request kept failing`, with the op, path,
reason and tries) and fails as before.

## Maintenance

Background work that keeps a long-running studio in step with its storage, each with a log line and a metric:

| Work | When | What |
|---|---|---|
| Warm a project | the first time a process finds a project, and for the three most recently used ones after a restart | its documents are loaded (shared with the request that found it) and its last 100 commits read into the object cache, so the first History after a deploy does not walk the log one round trip at a time (26.5 s on OpenList after the redeploy of 25 October). The recently used projects are kept in `${RIDEO_DATA_DIR}/recent-projects.json` (the last 20, written every 5 minutes and at shutdown). `rideo_projects_warmed_total` |
| Notice deleted folders | every 10 minutes | each loaded project is looked up on storage again (`existing` with `verify`, two looks a second apart); one whose folder is gone is forgotten, so a project deleted over WebDAV stops being served from memory. Sync did this only for projects with live subscribers. `rideo_projects_vanished_total` |
| Empty the trash | a minute after start, then daily | a deleted project (`trash/<id>-<time>`, or `projects/<id>.trashed-<time>` on a server that cannot move folders) is removed for good 7 days after its deletion (the time in its name), as a browser's trash is. `rideo_trash_purged_total` |

## Embedded server

When `RIDEO_WEBDAV_URL` is empty, Rideo mounts `webdav-server` v2 at **`/dav`** on its own HTTP server, backed
by `${RIDEO_DATA_DIR}/dav`. It is mounted through the Fastify `serverFactory`, before Fastify routing, so
WebDAV methods and bodies never reach Fastify's parsers. The storage backend then points at
`http://127.0.0.1:${port}/dav` over loopback. Optional Basic auth: `RIDEO_DAV_USERNAME` / `RIDEO_DAV_PASSWORD`.

Under a subpath the server is at `<base>/dav/` and writes its `href`s with that prefix
([subpath](subpath.md#what-the-server-writes-with-the-base)).

Mount it like any WebDAV share:

| Client | How |
|---|---|
| macOS Finder | Go → Connect to Server → `http://HOST:8787/dav/` |
| Windows | Map network drive → `http://HOST:8787/dav` |
| Linux | `mount -t davfs http://HOST:8787/dav /mnt/rideo` or `rclone mount` |

External servers known to work: OpenList/AList WebDAV, Nextcloud (`…/remote.php/dav/files/<user>`), Apache
`mod_dav` (the CI compatibility job), and `rclone serve webdav`.

## Layout

All paths are under `RIDEO_WEBDAV_ROOT` (default `/rideo`).

```
/rideo
├── projects/<projectId>/
│   ├── project.json              ┐
│   ├── screenplay.json           │  work tree: pretty-printed copies of the HEAD documents
│   ├── characters/<id>.json      │
│   ├── elements/<id>.json        │  locations, props, styles  (human-readable; editable, see "External edits")
│   ├── clips/<id>.json           │
│   ├── timeline.json             │
│   ├── resources/<id>.json       │
│   ├── analyses/<id>.json        │
│   ├── exports/<id>.json         │
│   ├── localizations/<lang>.json │  translations and dubs of the cut (docs/design/localization.md)
│   ├── renders/<exportId>.json   ┘  the timeline a language-variant export rendered
│   ├── screenplay.md             derived rendering, regenerated on every screenplay change (read-only)
│   ├── media/                    immutable, content-addressed media
│   │   ├── refs/<character>-<view>-<hash12>.png
│   │   ├── refs/element-<name>-<view>-<hash12>.png
│   │   ├── keyframes/c<clip>-s<shot>-<hash12>.png
│   │   ├── takes/c<clip>-s<shot>-<hash12>.mp4        watermarked originals
│   │   ├── posters/<hash12>.jpg                       posters (generated takes: server; uploads: browser)
│   │   ├── frames/<hash12>.png                       sampled frames (judge evidence, last frames)
│   │   ├── music/<slug>-<hash12>.<ext>                generated music and score cues
│   │   ├── sfx/<slug>-<hash12>.mp3                    generated sound effects
│   │   ├── uploads/<slug>-<hash12>.<ext>
│   │   ├── luts/<slug>-<hash12>.cube                   3D LUTs (color looks)
│   │   ├── masks/<label>-matte-<hash12>.mp4           segmentation mattes (Remove the background)
│   │   ├── brand/<name>-<hash12>.<ext>                 a brand kit's fonts, logo and bumpers, copied when applied
│   │   ├── stems/<exportId>-<role>-<hash12>.wav       export stems (dialogue, music, effects)
│   │   ├── subtitles/<exportId>[-<lang>]-<hash12>.srt|.vtt  export subtitles
│   │   ├── thumbs/<exportId>-thumbnail-<n>-<hash12>.jpg  export thumbnails
│   │   └── exports/<exportId>-<hash12>.mp4|.mov|.tar   deliveries (MP4, ProRes master, PNG+WAV archive)
│   ├── inbox/                    drop files here over WebDAV → imported as resources
│   └── .rideo/
│       ├── HEAD                  "ref: refs/heads/main"
│       ├── refs/heads/<branch>   commit hash
│       ├── refs/tags/<tag>       commit hash
│       ├── objects/ab/cdef….json content-addressed blobs, trees, commits
│       ├── worktree.json         work-tree index (hash + etag of each materialized file)
│       ├── summary.json          what the project list and the Inbox show (a cache, rebuilt when missing or behind)
│       ├── logs/<branch>.json    the branch's last 200 commit summaries (a cache, caught up when behind)
│       └── jobs/<jobId>.json     job records (operational, not versioned)
├── accounts/users/<userId>.json   people of the studio (docs/design/accounts.md)
├── accounts/tokens/<tokenId>.json agent tokens (the secret's SHA-256 only)
└── watermarks/<watermarkId>.json provenance registry (global)
```

### Media references

Documents never embed media bytes. They hold a `MediaRef`:

```ts
type MediaRef = {
  path: string;        // relative to the project folder, e.g. "media/takes/c0-s2-9ab3c1d2e4f5.mp4"
  hash: string;        // sha256 hex of the stored bytes
  mime: string;
  size: number;
  width?: number; height?: number; durationSec?: number; fps?: number; hasAudio?: boolean;
  videoCodec?: string; audioCodec?: string;   // ffmpeg codec names, e.g. "h264", "aac"
  poster?: { path: string; mime: string };
};
```

There are no proxy files on the server: a browser that cannot decode an original builds a local proxy in
its own storage ([editor](editor.md#playback-compatibility-local-proxies)). Older documents with a `proxy`
field still parse; the field is dropped.

Media files are **write-once**: the filename embeds the hash, so a new version is always a new file, and
every commit in the history still resolves its media. Nothing removes media a project no longer names; there is too
little of it to be worth the risk ([garbage collection](version-control.md#garbage-collection)).

### Local cache and staging

The server's ffmpeg (generation and watermarking) needs local files. `MediaStore.localPath(ref)` downloads a media file once into
`${RIDEO_DATA_DIR}/cache/media/<hash>.<ext>`, verifies the hash, and serves it from there. The cache is an
LRU bounded by `RIDEO_CACHE_MAX_BYTES` (default 5 GiB). It is only a cache: deleting it loses nothing.

Web Push keys and devices ([installable app](pwa.md)) are kept in `${RIDEO_DATA_DIR}/push/` (`vapid.json`, and
`<userId>.json` with each person's subscriptions).

The [search](search.md) index of a project is derived data too: `${RIDEO_DATA_DIR}/search/<projectId>.json`, rebuilt
by the next index run when lost (at the cost of captioning the frames again).

Files uploaded by editor jobs (render parts, soundtrack, analysis thumbnails, speech audio) are staged in
`${RIDEO_DATA_DIR}/staging/<jobId>/` until the job's follow-up has consumed them; only the published
results (export, thumbnails) are written to WebDAV. Staging folders of finished jobs are removed after the
follow-up job completes, and orphans after 24 h.

### Serving media to the browser

`GET /api/projects/:id/media/<path>` supports `Range`. It serves from the local cache when warm. Otherwise
it streams from WebDAV with the range forwarded, and rebuilds `Content-Range` from `stat().size`, because
some servers reply `bytes a-b/*`. WebCodecs (mediabunny `UrlSource`) relies on correct ranges for seeking.

## External edits

Assets are meant to be managed over WebDAV, so the work tree is a real editing channel, not just an export:

1. After each commit, the **work-tree materializer** writes the changed documents as pretty JSON, records
   `{hash, etag, size}` in `.rideo/worktree.json`, and re-renders `screenplay.md`. It runs behind the commits, so a
   commit never waits for it: the commit queues its documents, and one batch at a time writes the newest version of
   every queued path (a burst of edits to `timeline.json` costs one write, not one per edit), up to 8 files at once.
   A failed batch goes back in the queue and is tried again after 1 s, doubling up to 30 s. When a project is loaded,
   the index is compared with HEAD, and documents whose recorded hash is not HEAD's (a batch lost to a crash) are
   queued again; files edited outside Rideo keep their index entry, so sync still sees those edits. Sync waits for
   the queue before it scans and before it answers (up to 30 s: commits that keep coming keep it busy), and shutdown
   waits up to 15 s for the queues. `rideo_worktree_batches_total{outcome}` and `rideo_worktree_pending_docs` follow the
   queue.
2. **Sync** (on project open, on a timer for projects with live subscribers
   (`RIDEO_WEBDAV_SYNC_INTERVAL_SEC`, default 15, 0 disables), and on demand through
   `POST /api/projects/:id/sync` or the MCP tool `project_sync`) lists the work-tree folders and compares
   etag and size with the index. For each changed file it reads the bytes and compares the sha256. A real
   change is parsed and validated against the document schema for its path:
   - valid → committed with actor `{kind: "webdav"}` and message `External edit via WebDAV: <paths>`;
   - invalid → not committed; a `syncIssue` `{path, error}` is published and shown in the UI; the file stays
     untouched until it is fixed or `sync {discardInvalid: true}` re-materializes HEAD;
   - deleted document → committed as a deletion (restorable from history), but only once a direct `stat` of the
     file confirms it is gone. A listing can lag a write (OpenList caches directory listings): a document the
     listing leaves out but `stat` finds is compared like any other file, and the miss is logged
     (`work-tree listing missed a file`, with the project and path). `project.json` cannot be deleted and is
     re-materialized.
3. **Inbox**: files dropped into `inbox/` are imported on sync. Images, video and audio become resources
   (`role` inferred: `source` for videos in edit projects, `reference` for images, `music` for audio) and
   their bytes move to `media/uploads/`.

## Invariants

- Object and media files are immutable once written. Only refs, `HEAD`, `worktree.json`, job records and
  work-tree copies are rewritten.
- A ref update is the linearization point of a commit. Objects are written before the ref moves, so a crash
  leaves only unreferenced objects behind, never a dangling ref.
- Paths are built only by `storage/layout.ts`. Every id is validated (`^[a-z]{3}_[0-9a-z]{10,32}$`) before
  it is used in a path, so user input cannot traverse the tree.
