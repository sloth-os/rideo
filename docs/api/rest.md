# REST API

Base path `/api`. JSON in and out, except uploads (multipart) and media (bytes). When `RIDEO_API_TOKEN` is
set, every `/api` route except `/api/health` requires `Authorization: Bearer <token>`. REST calls are
attributed to the configured user actor (`RIDEO_USER_ID`, `RIDEO_USER_NAME`).

Errors are RFC 9457 problem details (`application/problem+json`) with a stable `code`:

```json
{ "type": "urn:rideo:problem:character_not_locked", "title": "Character Not Locked", "status": 409,
  "detail": "Mira must be locked before shots that include her can be generated.",
  "code": "character_not_locked", "errors": [] }
```

| Code | Status | Meaning |
|---|---|---|
| `validation_error` | 422 | body, params or document failed schema validation (`errors[]` lists the issues) |
| `not_found` | 404 | project, document, job, commit, … |
| `conflict` | 409 | concurrent modification, duplicate name, branch in use |
| `character_not_locked` | 409 | R1 precondition |
| `character_locked` | 409 | R2: edit a locked character |
| `consistency_gate` | 409 | R7: approval or export blocked by unverified, failed or stale takes |
| `gate_unmet` | 409 | workflow gate requirements not satisfied (`errors[]` lists them) |
| `timeline_op_invalid` | 422 | a timeline op failed (`errors[0].opIndex`) |
| `gateway_error` | 502 | mm-gateway returned an error |
| `llm_invalid_output` | 502 | the LLM output failed validation after repair |
| `storage_error` | 503 | the WebDAV backend failed |
| `unauthorized` | 401 | missing or wrong token |

## System

| Method | Path | Result |
|---|---|---|
| GET | `/api/health` | `{status: "ok", version, instanceId}` |
| GET | `/api/ready` | `{status, checks: {storage, gateway, ffmpeg, llm}}` |
| GET | `/api/config` | public config: brand, features (`mcp`, `embeddedDav`, `judge`, `stt`), defaults, model catalogue from the gateway |
| GET | `/metrics` | Prometheus text |

## Projects and documents

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/projects` | – | `ProjectSummary[]` |
| POST | `/api/projects` | `{kind, title, brief?: {prompt}, settings?}` | `201 Project` |
| GET | `/api/projects/:id/state` | – | `{seq, head, docs, jobs, workflow, syncIssues}` |
| PATCH | `/api/projects/:id` | `{title?, brief?, settings?}` (deep merge) | `Project` |
| DELETE | `/api/projects/:id` | – | `204` (moved to `/rideo/trash/`) |
| POST | `/api/projects/:id/sync` | `{discardInvalid?}` | WebDAV sync report |
| POST | `/api/projects/:id/gc` | – | GC report |
| GET | `/api/projects/:id/docs/*path` | `?at=<commit>` | document |
| GET | `/api/projects/:id/media/*path` | `Range` supported | bytes |
| POST | `/api/projects/:id/uploads` | multipart `file`, fields `kind?`, `role?`, `name?` | `Resource` (+ `resource.process` job) |
| POST | `/api/projects/:id/resources` | `{uri, kind?, role?, name?}` | `Resource` |

## Workflow

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/projects/:id/workflow` | – | `WorkflowEvaluation` |
| POST | `/api/projects/:id/workflow/approve` | `{gate}` | evaluation, or `gate_unmet` |
| POST | `/api/projects/:id/workflow/reopen` | `{stage}` | evaluation |

## Story and cast

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/projects/:id/screenplay/generate` | `{prompt?, attachmentResourceIds?}` | `Job` |
| PATCH | `/api/projects/:id/screenplay` | `{fields?, upsertScenes?, removeSceneIds?, outline?}`; header `X-Rideo-Coalesce: <key>` for typing sessions | `Screenplay` |
| POST | `/api/projects/:id/screenplay/extend` | `{beats?}` | `Job` |
| POST | `/api/projects/:id/characters` | `{name, role?, summary?, identity?, wardrobe?}` | `Character` |
| PATCH | `/api/projects/:id/characters/:cid` | character fields | `Character` (`character_locked` while locked) |
| DELETE | `/api/projects/:id/characters/:cid` | – | `204` |
| POST | `/api/projects/:id/characters/:cid/references/generate` | `{views?}` | `Job` |
| POST | `/api/projects/:id/characters/:cid/references` | multipart `file` + `view`, or `{uri, view?}` | `Character` |
| PATCH | `/api/projects/:id/characters/:cid/references/:rid` | `{approved}` | `Character` |
| DELETE | `/api/projects/:id/characters/:cid/references/:rid` | – | `Character` |
| POST | `/api/projects/:id/characters/:cid/describe` | `{resourceId}` | `Job` |
| POST | `/api/projects/:id/characters/:cid/lock` / `unlock` | – | `Character` |
| POST | `/api/projects/:id/music` | `{prompt, durationSec?, instrumental?}` | `Job` |

## Clips, shots, takes

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/projects/:id/clips/plan` | `{sceneId}` | `Job` |
| POST | `/api/projects/:id/clips/:clipId/generate` | – | `Job` |
| PATCH | `/api/projects/:id/clips/:clipId/shots/:shotId` | shot fields | `Clip` |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/regenerate` | – | `Job` |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/takes/:takeId/select` | – | `Clip` |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/takes/:takeId/override` | `{reason}` | `Clip` |
| POST | `/api/projects/:id/clips/:clipId/approve` | – | `Clip` (or `consistency_gate`) |
| POST | `/api/projects/:id/batch` | `{maxGenerations?}` | `Job` |
| DELETE | `/api/projects/:id/batch` | – | `{cancelled: jobId \| null}` |

## Timeline, analysis, export

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/projects/:id/timeline` | – | `Timeline` |
| POST | `/api/projects/:id/timeline/ops` | `{ops[]}` | `{timeline, commit}` |
| POST | `/api/projects/:id/timeline/assemble` | `{captions?, musicResourceId?}` | `{timeline, commit}` |
| POST | `/api/projects/:id/analyses` | `{resourceId}` | `Job` |
| PATCH | `/api/projects/:id/analyses/:aid/suggestions` | `{decisions: [{id, status}]}` | `Analysis` |
| POST | `/api/projects/:id/analyses/:aid/auto-edit` | – | `{timeline, commit}` |
| POST | `/api/projects/:id/exports` | `{quality?}` | `Job` |
| POST | `/api/projects/:id/exports/upload` | multipart `file` + `meta` JSON | `Export` (+ finishing job) |
| GET | `/api/projects/:id/exports` | – | `Export[]` |

## History

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/projects/:id/history` | `?path&limit&before&branch` | `CommitSummary[]` |
| GET | `/api/projects/:id/history/diff` | `?from&to` | `Diff` |
| GET | `/api/projects/:id/history/:commit` | – | `CommitDetail` |
| POST | `/api/projects/:id/history/restore` | `{commit, paths?}` | `CommitSummary` |
| GET/POST | `/api/projects/:id/branches` | `{name, from?}` | branches / `Branch` |
| POST | `/api/projects/:id/branches/:name/switch` | – | `{branch, commit}` |
| DELETE | `/api/projects/:id/branches/:name` | – | `204` |
| GET/POST | `/api/projects/:id/tags` | `{name, commit?, message?}` | tags / `Tag` |

## Jobs

| Method | Path | Result |
|---|---|---|
| GET | `/api/projects/:id/jobs?status=` | `Job[]` |
| GET | `/api/projects/:id/jobs/:jobId` | `Job` |
| POST | `/api/projects/:id/jobs/:jobId/cancel` | `Job` |

## Watermark

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/watermark/detect` | multipart `file`, or `{uri}`, or `{projectId, mediaPath}` | `{found, id?, confidence, provenance?, metadata}` |
| GET | `/api/watermark/:wmId` | – | registry record |

## Other surfaces

- `GET /api/live`: WebSocket, see [realtime-sync](../design/realtime-sync.md).
- `/mcp`: MCP Streamable HTTP, see [mcp](../design/mcp.md).
- `/dav/*`: embedded WebDAV, see [storage-webdav](../design/storage-webdav.md).
