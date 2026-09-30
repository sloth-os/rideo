# Storage: assets on WebDAV

Every byte Rideo persists (documents, media, version history, job records, the watermark registry) lives on
a **WebDAV** server. Rideo talks WebDAV even to its own embedded server, so the external and embedded setups
exercise one code path.

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
| `WebDavBackend` | Production. Wraps the `webdav` client. It creates parent collections on demand (MKCOL, with a known-directory cache), streams uploads and downloads, forwards `Range`, and sends `If-Match` / `If-None-Match` when the server supports them. |
| `MemoryBackend` | Unit tests. Same semantics, including conditional writes. |

`capabilities()` probes once per process. It writes a probe file twice with `If-None-Match: *`; a `412` on the
second write means the server honours preconditions (Apache mod_dav, Nextcloud and rclone do; the embedded
`webdav-server` does not). Either way, every project write goes through an in-process **per-project mutex**,
which is correct for one Rideo instance per WebDAV root. Conditional writes add protection against other
writers.

## Embedded server

When `RIDEO_WEBDAV_URL` is empty, Rideo mounts `webdav-server` v2 at **`/dav`** on its own HTTP server, backed
by `${RIDEO_DATA_DIR}/dav`. It is mounted through the Fastify `serverFactory`, before Fastify routing, so
WebDAV methods and bodies never reach Fastify's parsers. The storage backend then points at
`http://127.0.0.1:${port}/dav` over loopback. Optional Basic auth: `RIDEO_DAV_USERNAME` / `RIDEO_DAV_PASSWORD`.

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
│   ├── characters/<id>.json      │  (human-readable; editable, see "External edits")
│   ├── clips/<id>.json           │
│   ├── timeline.json             │
│   ├── resources/<id>.json       │
│   ├── analyses/<id>.json        │
│   ├── exports/<id>.json         ┘
│   ├── screenplay.md             derived rendering, regenerated on every screenplay change (read-only)
│   ├── media/                    immutable, content-addressed media
│   │   ├── refs/<character>-<view>-<hash12>.png
│   │   ├── keyframes/c<clip>-s<shot>-<hash12>.png
│   │   ├── takes/c<clip>-s<shot>-<hash12>.mp4        watermarked originals
│   │   ├── posters/<hash12>.jpg                       posters (generated takes: server; uploads: browser)
│   │   ├── frames/<hash12>.png                       sampled frames (judge evidence, last frames)
│   │   ├── music/<slug>-<hash12>.<ext>
│   │   ├── uploads/<slug>-<hash12>.<ext>
│   │   └── exports/<exportId>-<hash12>.mp4
│   ├── inbox/                    drop files here over WebDAV → imported as resources
│   └── .rideo/
│       ├── HEAD                  "ref: refs/heads/main"
│       ├── refs/heads/<branch>   commit hash
│       ├── refs/tags/<tag>       commit hash
│       ├── objects/ab/cdef….json content-addressed blobs, trees, commits
│       ├── worktree.json         work-tree index (hash + etag of each materialized file)
│       └── jobs/<jobId>.json     job records (operational, not versioned)
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
every commit in the history still resolves its media. Unreferenced media can be removed with
`POST /api/projects/:id/gc`, which keeps anything reachable from any branch or tag.

### Local cache and staging

The server's ffmpeg (generation and watermarking) needs local files. `MediaStore.localPath(ref)` downloads a media file once into
`${RIDEO_DATA_DIR}/cache/media/<hash>.<ext>`, verifies the hash, and serves it from there. The cache is an
LRU bounded by `RIDEO_CACHE_MAX_BYTES` (default 5 GiB). It is only a cache: deleting it loses nothing.

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
   `{hash, etag, size}` in `.rideo/worktree.json`, and re-renders `screenplay.md`.
2. **Sync** (on project open, on a timer for projects with live subscribers
   (`RIDEO_WEBDAV_SYNC_INTERVAL_SEC`, default 15, 0 disables), and on demand through
   `POST /api/projects/:id/sync` or the MCP tool `project_sync`) lists the work-tree folders and compares
   etag and size with the index. For each changed file it reads the bytes and compares the sha256. A real
   change is parsed and validated against the document schema for its path:
   - valid → committed with actor `{kind: "webdav"}` and message `External edit via WebDAV: <paths>`;
   - invalid → not committed; a `syncIssue` `{path, error}` is published and shown in the UI; the file stays
     untouched until it is fixed or `sync {discardInvalid: true}` re-materializes HEAD;
   - deleted document → committed as a deletion (restorable from history). `project.json` cannot be deleted
     and is re-materialized.
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
