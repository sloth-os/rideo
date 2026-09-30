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
4. Write the blob objects, the rewritten trees on the changed paths, and the commit object.
5. Move the branch ref (`If-Match` on its etag when the backend supports conditional writes; otherwise the
   in-process lock is authoritative).
6. Update the in-memory snapshot cache, materialize the work tree (when `branch` is checked out), and emit a
   `commit` live event with the new documents.

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

`POST /api/projects/:id/gc` marks every commit reachable from any branch or tag, then their trees and
blobs, then every `media/` path referenced by those documents or by active job records. It deletes
unreachable objects and media older than one hour (a grace period for in-flight commits). GC is never run
automatically.

## Caching

The repository keeps an LRU of flattened snapshots (`commit → Map<path, blobId>`) and parsed blobs. The
checked-out branch's full document set is kept hot, so `GET /state` needs no WebDAV round trips in steady
state.
