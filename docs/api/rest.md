# REST API

Base path `/api`. JSON in and out, except uploads (multipart) and media (bytes). When `RIDEO_API_TOKEN` is
set, every `/api` route except `/api/health` and file uploads to `/api/watermark/detect` (the public detection
tool) requires `Authorization: Bearer <token>`. REST calls are
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
| `element_not_locked` | 409 | E1 precondition: a shot's location or prop is not locked ([elements](../design/elements.md)) |
| `element_locked` | 409 | E2: edit a locked element |
| `voice_not_locked` | 409 | V1 precondition: a speaker of the shot has no locked voice ([dialogue](../design/dialogue.md)) |
| `voice_locked` | 409 | V2: change a locked voice |
| `board_unapprovable` | 409 | approving a storyboard frame that is missing, failed, stale or outdated ([storyboard](../design/storyboard.md)) |
| `tts_unavailable` | 422 | voices or TTS dialogue without a TTS provider on the server (or cloning with one that cannot clone) |
| `consistency_gate` | 409 | R7: approval or export blocked by unverified, failed or stale takes |
| `gate_unmet` | 409 | workflow gate requirements not satisfied (`errors[]` lists them) |
| `timeline_op_invalid` | 422 | a timeline op failed (`errors[0].opIndex`) |
| `gateway_error` | 502 | mm-gateway returned an error |
| `llm_invalid_output` | 502 | the LLM output failed validation after repair |
| `storage_error` | 503 | the WebDAV backend failed |
| `lease_lost` | 409 | an editor job is no longer leased to this session (expired, cancelled or reassigned) |
| `consent_required` | 422 | an uploaded reference or voice sample of a real person lacks its consent record ([provenance](../design/provenance.md#consent-records)) |
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
| POST | `/api/projects/:id/uploads` | multipart `file`, optional `poster` (JPEG) and `meta` JSON `{probe, kind?, role?, name?}` (`probe`: `ProbeSchema`, made by the browser) | `Resource`: `ready` with a probe; otherwise `processing` + a `media.process` editor job |
| POST | `/api/projects/:id/resources` | `{uri, kind?, role?, name?}` | `Resource` (`processing` + `media.process` editor job for audio/video) |

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
| POST | `/api/projects/:id/screenplay/import` | multipart `file` (+ `replace`), or `{uri, replace?}`, or `{text, format?: "fountain" \| "fdx" \| "pdf", replace?}` | `{title, scenes, characters, elements, durationSec}` (`conflict` when a screenplay exists without `replace`) |
| POST | `/api/projects/:id/characters` | `{name, role?, summary?, identity?, wardrobe?}` | `Character` |
| PATCH | `/api/projects/:id/characters/:cid` | character fields, `voice: {description}` | `Character` (`character_locked` / `voice_locked` while locked) |
| DELETE | `/api/projects/:id/characters/:cid` | – | `204` |
| POST | `/api/projects/:id/characters/:cid/references/generate` | `{views?}` | `Job` |
| POST | `/api/projects/:id/characters/:cid/references` | multipart `file` + `view` + `consent` (JSON), or `{uri, view?, consent}`; `consent: {depictsRealPerson, subject?, grantedBy?, grantedAt?, scope?, evidence?}` | `Character` (`consent_required` when a real person lacks subject, grantor or date) |
| PATCH | `/api/projects/:id/characters/:cid/references/:rid` | `{approved}` | `Character` |
| DELETE | `/api/projects/:id/characters/:cid/references/:rid` | – | `Character` |
| POST | `/api/projects/:id/characters/:cid/describe` | `{resourceId, consent}` (the photo becomes an uploaded reference) | `Job` |
| POST | `/api/projects/:id/characters/:cid/lock` / `unlock` | – | `Character` |
| POST | `/api/projects/:id/characters/:cid/voice/design` | – | `Job` (`voice.design`: three previews in `voice.candidates`) |
| POST | `/api/projects/:id/characters/:cid/voice/select` | `{candidateId}` | `Character` |
| POST | `/api/projects/:id/characters/:cid/voice/clone` | multipart `file` + `consent` (JSON), or `{uri, consent}` | `Character` (`consent_required`, `tts_unavailable`) |
| POST | `/api/projects/:id/characters/:cid/voice/lock` / `unlock` | – | `Character` (`voice_locked` for changes while locked) |
| POST | `/api/projects/:id/music` | `{prompt, durationSec?, instrumental?}` | `Job` |

## Elements (locations, props, styles)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/projects/:id/elements` | `{kind, name, description?, aliases?}` | `Element` |
| PATCH | `/api/projects/:id/elements/:eid` | `{name?, description?, aliases?}` | `Element` (`element_locked` while locked) |
| DELETE | `/api/projects/:id/elements/:eid` | – | `204` |
| POST | `/api/projects/:id/elements/:eid/references/generate` | `{views?}` | `Job` (`element.refs`) |
| POST | `/api/projects/:id/elements/:eid/references` | multipart `file` + `view`, or `{uri, view?}` | `Element` |
| PATCH / DELETE | `/api/projects/:id/elements/:eid/references/:rid` | `{approved}` / – | `Element` |
| POST | `/api/projects/:id/elements/:eid/lock` / `unlock` | – | `Element` |

## Storyboard and animatic

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/projects/:id/storyboard/generate` | `{sceneIds?}` | `Job` (`storyboard.generate`) |
| POST | `/api/projects/:id/storyboard/approve-all` | – | `{approved}` |
| POST | `/api/projects/:id/storyboard/animatic` | `{musicResourceId?, captions?}` | `{animatic: Timeline}` (`animatic.json`) |
| GET | `/api/projects/:id/shotlist.csv` / `shotlist.pdf` | – | the shot list (attachment) |

## Clips, shots, takes

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/projects/:id/clips/plan` | `{sceneId}` | `Job` |
| POST | `/api/projects/:id/clips/:clipId/generate` | – | `Job` |
| PATCH | `/api/projects/:id/clips/:clipId/shots/:shotId` | shot fields, including `camera.{lensMm, aperture, move}`, `startFrame`, `endFrame`, `motionReference`, `seed` ([directing](../design/directing.md)) | `Clip` |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/variations` | `{count: 2–4}` | `Job[]` (`shot.generate` with `variation`) |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/regenerate` | – | `Job` |
| POST | `/api/projects/:id/clips/:clipId/shots/reorder` | `{shotIds}` (every shot once) | `Clip` |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/board/generate` | – | `Job` (`shot.board`) |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/board/approve` | `{approved}` | `Clip` (`board_unapprovable`) |
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
| POST | `/api/projects/:id/analyses` | `{resourceId}` | `{analysis, job}` (`analysis.signals` editor job) |
| PATCH | `/api/projects/:id/analyses/:aid/suggestions` | `{decisions: [{id, status}]}` | `Analysis` |
| POST | `/api/projects/:id/analyses/:aid/auto-edit` | – | `{timeline, commit}` |
| POST | `/api/projects/:id/exports` | `{quality?, engine?: "auto" \| "ffmpeg" \| "webcodecs", source?: "timeline" \| "animatic"}` | `{export, job}` (`export.render` editor job) |
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

## Editor jobs

Browser tabs run editor jobs (`client` lane) with their editor engine; see
[editor](../design/editor.md#editor-jobs). `sessionId` is the tab's live-channel session.

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/editor/claim` | `{sessionId, projectId, kinds?[]}` | `{job}` (leased to the session) or `{job: null}` |
| GET | `/api/editor/jobs/:jobId` | – | `Job` (with `staged` file names, for resuming) |
| POST | `/api/editor/jobs/:jobId/heartbeat` | `{sessionId, progress?: {done, total, message?}}` | `{cancelled, leaseExpiresAt}` or `lease_lost` |
| PUT | `/api/editor/jobs/:jobId/files/:name` | raw bytes (`?sessionId=`) | `{name, size}` (staged; names `[a-z0-9._-]`) |
| POST | `/api/editor/jobs/:jobId/complete` | `{sessionId, result}` (per-kind `EditorResultSchema`) | `Job` (succeeded; follow-up job started) |
| POST | `/api/editor/jobs/:jobId/fail` | `{sessionId, error: {code, message}}` | `Job` (queued again while attempts remain, else failed) |

## Watermark and Content Credentials

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/watermark/detect` | multipart `file` (public, no token needed, ≤ `RIDEO_PUBLIC_DETECT_MAX_BYTES`), or with the token `{uri}` or `{projectId, mediaPath}` | `{found, id?, confidence, provenance?, metadata, contentCredentials}`; public callers get the brand, asset kind and creation time instead of the registry record ([provenance](../design/provenance.md#verification)) |
| GET | `/api/watermark/:wmId` | – | registry record |

## Other surfaces

- `GET /api/live`: WebSocket, see [realtime-sync](../design/realtime-sync.md).
- `/mcp`: MCP Streamable HTTP, see [mcp](../design/mcp.md).
- `/dav/*`: embedded WebDAV, see [storage-webdav](../design/storage-webdav.md).
