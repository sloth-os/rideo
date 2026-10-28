# Version control

Every project document is versioned in a small, git-like, content-addressed store that lives next to the
assets on WebDAV (`projects/<id>/.rideo/`). Every change from any actor (UI, agent, job, external WebDAV
edit) becomes a commit that records who, when, why and what. Media is versioned by construction: media
files are immutable and named by hash, and documents reference them.

## Objects

All objects are canonical JSON: keys sorted recursively, no insignificant whitespace, UTF-8. The object id
is `sha256(canonicalJson(object))` in hex, stored at `.rideo/objects/<id[0:2]>/<id[2:]>.json`. Reads
verify the hash.

```jsonc
// blob: one document
{ "type": "blob", "content": { /* e.g. a Character document */ } }

// tree: one directory level
{ "type": "tree", "entries": { "characters": { "kind": "tree", "hash": "…" },
                              "project.json": { "kind": "blob", "hash": "…" } } }

// commit
{ "type": "commit",
  "tree": "…", "parents": ["…"],
  "author": { "kind": "agent", "id": "claude-code", "name": "Claude Code" },
  "message": "Lock character Mira",
  "timestamp": "2026-09-30T10:00:00.000Z",
  "changes": [ { "path": "characters/chr_01j9….json", "op": "modify" } ],
  "meta": { "coalesceKey": "…", "restoredFrom": "…", "jobId": "…" } }
```

Trees are hierarchical, so a commit rewrites only the trees on the changed paths (typically 1–3 small
objects plus the blob and the commit). Unchanged subtrees are shared between commits.

Versioned document paths:

| Path | Document |
|---|---|
| `project.json` | project settings, brief, workflow state and approvals |
| `screenplay.json` | screenplay, outline, style bible |
| `characters/<characterId>.json` | character identity, references, lock |
| `clips/<clipId>.json` | clip with shots and takes |
| `timeline.json` | editing timeline |
| `resources/<resourceId>.json` | user-provided or generated resources |
| `analyses/<analysisId>.json` | footage analysis and suggestions |
| `exports/<exportId>.json` | export records |

## Refs

| File | Content |
|---|---|
| `.rideo/HEAD` | `{"branch": "main"}` |
| `.rideo/refs/heads/<branch>` | `{"commit": "<id>", "updatedAt": "…"}` |
| `.rideo/refs/tags/<tag>` | `{"commit": "<id>", "message": "…", "actor": {…}, "createdAt": "…"}` |

Branch and tag names must match `^[a-z0-9][a-z0-9._-]{0,63}$`.

## Commit protocol

`repo.commit({ changes, actor, message, branch?, meta?, coalesce? })` where `changes` maps a path to a new
document or to `null` for deletion:

1. Take the project write lock.
2. Validate each document against the schema for its path. Invalid input is rejected with `validation_error`.
3. Drop no-op changes (same blob hash). If nothing is left, return the current tip without committing.
4. Build the blob objects, the rewritten trees on the changed paths, and the commit object in memory, and write
   the ones not stored yet concurrently (up to 8 at a time). Nothing refers to them until the ref moves, so their
   order does not matter.
5. Move the branch ref (`If-Match` on its etag when the backend supports conditional writes; otherwise the
   in-process lock is authoritative). A commit is two storage round trips: the objects, then the ref.
6. Update the in-memory snapshot cache, queue the work-tree materialization (when `branch` is checked out; it runs
   in the background, see [external edits](storage-webdav.md#external-edits)), and emit a `commit` live event with
   the new documents.

### Coalescing

Typing in the screenplay editor should not create hundreds of commits. A commit **amends** the tip
(same parents; union of changes; the tip's message kept; `meta.coalescedCount` incremented) when all of
these hold:

- the caller passed `coalesce: { key }` (the UI sends e.g. `doc:screenplay.json` for text edits);
- the tip has the same author (`kind` + `id`) and the same `meta.coalesceKey`;
- the tip is younger than `RIDEO_COALESCE_WINDOW_SEC` (default 30 s);
- no tag points at the tip.

The replaced tip becomes an unreferenced object, and GC removes it later.

## Reading history

| Operation | API | MCP tool |
|---|---|---|
| Log (optionally filtered by path) | `GET /api/projects/:id/history?path=&limit=&before=` | `history_log` |
| Show one commit | `GET /api/projects/:id/history/:commit` | `history_show` |
| Diff two commits | `GET /api/projects/:id/history/diff?from=&to=` | `history_diff` |
| Read a document at a commit | `GET /api/projects/:id/docs/<path>?at=<commit>` | `doc_get` |

`diff` walks both trees, skipping identical subtree hashes, and lists `{path, op}`. For each changed
document it also returns a JSON diff: operations `{op: add|remove|replace, pointer, before, after}`. Arrays
of objects that carry an `id` are matched by id, so reordering scenes or shots shows up as moves, not as a
rewrite of the whole array.

## Restore, branches, tags

- **Restore** `{commit, paths?}` creates a *new* commit on the current branch that sets the given paths (or
  the whole project) to their state at `commit`, with `meta.restoredFrom`. History is never rewritten.
  Restoring a path from another branch's commit is how you cherry-pick a document between branches.
- **Branches**: create (from HEAD or a commit), switch (re-materializes the work tree), list, delete (not the
  checked-out branch). Jobs record their branch at enqueue time and commit to that branch even if the user
  switches in the meantime.
- **Tags**: workflow gates create tags automatically (`screenplay-approved`, `cast-locked`,
  `pilot-approved`, `production-approved`, `cut-approved`, `export-<id>`). Users and agents can add their own
  milestone tags.
- **Merge** is out of scope for v1 (see the architecture non-goals).

## Garbage collection

Rideo keeps every object and every media file of a project until the project is deleted (its folder is removed
for good 7 days later, [maintenance](storage-webdav.md#maintenance)); nothing collects garbage. Objects are written
once and only a commit that never reaches its ref, or a tip that a coalesced commit replaced, leaves any behind.
Measured on the demo server on October 28, 2026, walking every branch and tag through its whole history:

| Project | Commits | Objects | Unreachable | Media not named by the documents or job records |
|---|---|---|---|---|
| Sammy and Rosie Go Swimming | 503 | 1,964 | 0 | at most 31 of 810 files (16.5 MB of 2.1 GB, before the history is counted) |
| Sammy and Rosie Ski Fuji | 604 | 2,390 | 3 (0.1 %) | |
| Bao and Mei Learn to Surf | 471 | 1,879 | 0 | |
| Bao and Mei: demo edit (edited in the studio) | 51 | 155 | 0 | |

A collector would have to stop commits while it decides, never trust a lagging folder listing, and forget what the
object store believes it wrote; for a tenth of a percent that risk is not worth taking. Measure again when a project's
unreachable share passes a few percent.

## Caching

The repository keeps an LRU of flattened snapshots (`commit → Map<path, blobId>`) and parsed blobs. The
checked-out branch's full document set is kept hot, so `GET /state` needs no WebDAV round trips in steady
state: the project's existence is looked up once per process
([slow and flaky servers](storage-webdav.md#slow-and-flaky-servers)), the checked-out branch's tip comes from
memory (it moves only through this process), and tags are read once and kept up to date by `createTag` (one tag
is created at a time). The coalescing check reads the cached tags.

**The recent log.** A commit names only its parent, so walking the history reads one commit object after another:
100 commits were 100 round trips on a cold cache. Each branch's last 200 commit summaries are kept in memory and in
`.rideo/logs/<branch>.json` (`{branch, tip, commits}`, newest first), updated by every commit (a coalesced commit
takes the place of the tip it replaces) and written a few seconds behind a burst of commits, like the work tree.
`log` reads them: the file once per process, then memory. When the file is behind the branch's tip (another process
committed, or the write was lost), the commits from the tip down to the first one the file has are read and put in
front; when none is met within 200 commits, or the file is missing or unreadable, the log is walked from the objects
and the file written again. A page older than the window (`before`, a path filter that runs past it) goes on with the
walk from the oldest summary held.
