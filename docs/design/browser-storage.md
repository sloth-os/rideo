# Browser storage

When no WebDAV server is configured (`RIDEO_STORAGE=browser`, the default of a fresh studio, see
[settings](settings.md#storage-mode-on-first-start)), projects live **in the browser** that created them: its
IndexedDB holds every document, the version history and the media. The server keeps no copy; it works on a project
by asking the browser for the files it needs, over the live channel the tab already has open. Projects move between
browsers and studios as **project files** (`.rideo`), exported and imported from the dashboard.

Because the server's own code paths are unchanged (it still reads and writes through a `StorageBackend`), every
surface works on a browser project as long as one tab of that browser is open: the editor, jobs, MCP tools and agents.

## Workspaces

A **workspace** is one browser's project store: the IndexedDB database `rideo-workspace` of the studio's origin. Its id
(`ws_` and 26 random base-36 characters) is made on first use and kept in the database and in `localStorage`
(`rideo.workspace`). The id is the routing key and is treated as a secret: it travels only to the studio server.

| Store | Key | Value |
|---|---|---|
| `meta` | `"workspace"` | `{id, createdAt}` |
| `entries` | path (relative to the studio's root, e.g. `/projects/prj_…/project.json`), index `parent` | `{path, parent, isDir, size, etag, mtime, contentType?, blob?}` |
| `blobs` | blob key | the file's bytes as a `Blob` |

Directories are explicit entries, created on write like `mkdir -p`, so a listing is one index read. File bytes live
apart from their entries, so listing and `stat` never load data and a move (a project going to the trash) only
rewrites entries. Etags are random per write; conditional writes (`ifMatch`, `ifNoneMatch: "*"`) are checked inside
the IndexedDB transaction, so tabs of the same browser cannot lose each other's ref updates.

The app asks for persistent storage (`navigator.storage.persist()`) when it first stores a project, and shows the
space used and available (`navigator.storage.estimate()`) on the dashboard and in Settings. A browser can still
evict data of a site it was not allowed to persist, or a person can clear it: the dashboard says that projects are
kept in this browser and offers to export them.

## The protocol

The tab attaches its workspace after the live channel's `hello` ([realtime sync](realtime-sync.md#channel)):

| Direction | Message | Meaning |
|---|---|---|
| client → server | `{type: "workspace", workspaceId}` | this session serves the workspace's files |
| server → client | `{type: "storage", id, op, path, …}` | a storage operation: `read` (`range?`), `stat`, `list`, `write` (`data?` or `transfer?`, `size`, `ifMatch?`, `ifNoneMatch?`, `contentType?`), `delete`, `move` (`to`) |
| client → server | `{type: "storage-result", id, ok, result?, data?, error?}` | its answer; `data` is base64 for reads up to 256 KiB, `error` is `{code, message}` (`not_found` → `null` for reads) |

Payloads above 256 KiB go over HTTP beside the socket, so large media never sits in a WebSocket message:

| Route | Use |
|---|---|
| `GET /api/workspace/transfers/:id` | the browser fetches what the server writes (a generated take, a finished export); the `storage` message names the transfer |
| `PUT /api/workspace/transfers/:id` | the browser sends what the server reads (`application/octet-stream`, headers `x-rideo-size` and `x-rideo-range: start-end`); the body streams straight to the reader (the media route, ffmpeg's cache) |

Transfer ids are random, single-use and expire after 10 minutes; the routes need the same authentication as the rest
of `/api`.

## Routing on the server

In browser mode the studio's storage is a `RoutedStorage` (`packages/server/src/storage/routed.ts`):

| Path (under the root) | Backend |
|---|---|
| `projects/<projectId>/**`, `trash/<projectId>-<time>/**` of a browser project | `WorkspaceStorage` of the workspace that holds the project (RPC above) |
| `projects/<projectId>/**` of a project in the data directory | the data directory (`FsBackend`, below) |
| `projects` (the listing) | the data directory's projects, plus the projects of the caller's workspace (REST), or of every attached workspace (MCP, jobs) |
| everything else: accounts, tokens, brand kits, recipes, the watermark registry | `FsBackend` over `<dataDir>/dav`, the directory the embedded WebDAV server uses, so studio data stays put when the storage mode changes |

**Which workspace holds a project.** The server keeps a map from project to workspace, filled when a workspace
attaches (it lists the workspace's `projects` folder) and when a project is created or imported. A request names its
workspace: the app sends `x-rideo-workspace` on every API call and `ws=` on media URLs (an `<img>` or `<video>`
sends no headers), MCP clients may add `?workspace=` to the `/mcp` URL. For a project the map does not know yet, the
server asks the request's workspace (`stat`) and remembers the answer; a new project (the first write to an unknown
project folder) goes to the request's workspace, or, without one, to the workspace that attached most recently.

**When the browser is not there.** An operation on a project whose workspace has no open tab waits up to 5 seconds
for one to attach (a tab reconnecting after a server restart), then fails with `storage_offline` (503, retryable):
"This project is stored in a browser that is not connected. Open Rideo in that browser." Jobs that fail this way are
retried by the queue's normal policy and resume when the tab returns: their records are loaded again when the
workspace attaches. Pending operations of a session that closes fail at once (also `storage_offline`); the next operation
goes to another tab of the same workspace when one is attached.

**Who may attach.** A workspace is bound to the person who first attached it after the server started (or to the
studio user without accounts); another person's session cannot attach it (`forbidden`). A project in a workspace
keeps its [access](accounts.md) rules: other people reach it only while its browser is open, and only with a role.

The WebDAV sync timer skips browser projects (nothing edits them from outside). Search indexes, notifications, the
media cache and editor-job staging stay in the server's data directory, as in every mode
([storage](storage-webdav.md#local-cache-and-staging)).

### FsBackend

A `StorageBackend` over a local directory: atomic writes (temporary file and rename), ranges, conditional writes
under an in-process lock (etag = size and mtime), and recursive delete and move. It holds the studio-wide data in
browser mode.

## Media in the browser

Media URLs of browser projects carry `ws=`, and in production builds the service worker answers
`GET …/api/projects/<projectId>/media/<path>?…ws=…` from IndexedDB, with `Range` (`206`, `Content-Range`), so the
player, the waveform and the editor engine read local bytes without a round trip. A miss (a file the server is still
writing) goes to the network, where the server reads it from the workspace like any other storage.

## Project files (export and import)

A project travels as a **project file**, `<title>.rideo`: a POSIX tar archive (ustar, long names in the 155-byte
prefix) whose first entry is the manifest and whose other entries are the project folder:

```
rideo-project.json        {format: "rideo-project", version: 1, projectId, title, kind, createdAt, exportedAt,
                           generator: "Rideo 0.1.0", head: {branch, commit}, files, bytes}
project/project.json      …the work tree, media/, and .rideo/ (HEAD, refs, objects, worktree.json)
```

The manifest's schema (`ProjectBundleManifestSchema`), the entry rules (`project/` prefix, no `..`, `.rideo/jobs/` and
`inbox/` left out) and the tar reader and writer (`packages/shared/src/bundle`) are shared by the server and the
browser. Media is stored already compressed, so the archive is not.

| Where the project is | Export | Import |
|---|---|---|
| this browser | built in the browser from IndexedDB (`Blob` parts: no copy of the media) and downloaded | read in the browser from the chosen file (`File.slice`: no copy) and written to IndexedDB |
| a WebDAV store or the data directory | `GET /api/projects/:id/export`, streamed by the server | `POST /api/projects/import` (`application/octet-stream`), streamed into the storage |

**Import rules.** The manifest is validated first; every entry path is checked; documents are validated against
their schemas when the server first reads them, like an external edit. The project keeps its id unless the target
already has it: then the import stops with `conflict` (409) unless the caller chose `mode=replace` (the existing
project goes to the trash first) or `mode=copy` (a new id). A copy rewrites the history so that every commit's
`project.json` names the new id (`rewriteProjectId` in `packages/shared/src/bundle`: new blobs for each
`project.json`, new root trees, new commits in topological order, refs moved to the new commits) and appends
" (copy)" to the title in a new commit; media files are reused as they are. The imported project's jobs are not
carried over.

| Surface | Export | Import |
|---|---|---|
| UI | Dashboard card menu and project Overview → Export project file | Dashboard → Import project (asks Replace or Keep both on a conflict) |
| REST | `GET /api/projects/:id/export` (`project.read`) | `POST /api/projects/import?mode=` (body: the file) → `201` project summary |
| MCP | `project_export` → `{url}` to download | `project_import {url, mode?}` (the server downloads the file) |

## Limits

- One studio tab per browser is enough; with several, the server uses the one that was active last.
- Browser storage is per origin and per browser profile: a project made in one browser is not in another until it is
  exported and imported.
- Quotas are the browser's (typically a share of the free disk); a write that exceeds the quota fails with
  `storage_error` and the message the browser gave.
- Agents (MCP) see browser projects only while a tab of their browser is open. For studios driven headless, use a
  WebDAV server or the built-in one (`RIDEO_STORAGE=embedded`).
