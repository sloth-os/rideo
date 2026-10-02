# REST API

Base path `/api`. JSON in and out, except uploads (multipart) and media (bytes). Who is calling
([accounts](../design/accounts.md)): without accounts, the configured user (`RIDEO_USER_ID`, `RIDEO_USER_NAME`),
with `Authorization: Bearer <RIDEO_API_TOKEN>` when that is set; with accounts (`RIDEO_OIDC_ISSUER`), a signed-in
person (the `rideo_session` cookie), an agent token (`Bearer rdo_…`, acting on behalf of its owner) or the studio
token. Every route except `/api/health`, `/api/ready`, `/api/auth/*`, the guest routes of review links
(`/api/review/*`, where the link's token is the access) and file uploads to `/api/watermark/detect` (the public
detection tool) needs one (401). Project routes also need a permission of the caller's role in the
project (`project.read` for reads, `project.edit` for writes, `project.approve` for approvals, `project.manage` for
settings, access and branches; `project.comment` for review comments and decisions): 403 `forbidden` otherwise, and
the project list only shows readable projects.

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
| `localization_incomplete` | 409 | a language variant or translated subtitles while a line of the cut has no current translation, or (dubbed) a speaking take has no current dub |
| `sfx_unavailable` | 422 | sound effects without a sound-effects provider on the server (`RIDEO_SFX_PROVIDER`) |
| `segmentation_unavailable` | 422 | Remove the background without a segmentation model on the gateway (`supports_segmentation`), or with `settings.models.segment: "off"` ([editor](../design/editor.md#segmentation-masks-remove-the-background)) |
| `consistency_gate` | 409 | R7: approval or export blocked by unverified, failed or stale takes |
| `gate_unmet` | 409 | workflow gate requirements not satisfied (`errors[]` lists them) |
| `timeline_op_invalid` | 422 | a timeline op failed (`errors[0].opIndex`) |
| `gateway_error` | 502 | mm-gateway returned an error |
| `llm_invalid_output` | 502 | the LLM output failed validation after repair |
| `storage_error` | 503 | the WebDAV backend failed |
| `lease_lost` | 409 | an editor job is no longer leased to this session (expired, cancelled or reassigned) |
| `consent_required` | 422 | an uploaded reference or voice sample of a real person lacks its consent record ([provenance](../design/provenance.md#consent-records)) |
| `unauthorized` | 401 | not signed in, or a missing, wrong, revoked or expired token |
| `forbidden` | 403 | the caller's role in the project does not allow it, or an admin-only route |

## System

| Method | Path | Result |
|---|---|---|
| GET | `/api/health` | `{status: "ok", version, instanceId}` |
| GET | `/api/ready` | `{status, checks: {storage, gateway, ffmpeg, llm}}` |
| GET | `/api/config` | public config: brand, features (`mcp`, `embeddedDav`, `judge`, `stt`), defaults, model catalogue from the gateway |
| GET | `/metrics` | Prometheus text |

## Accounts

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/auth/me` | – | `{mode: "none" \| "token" \| "oidc", provider, user, token, admin}` |
| GET | `/api/auth/login` | `?returnTo&login_hint` | 302 to the identity provider (PKCE) |
| GET | `/api/auth/callback` | `?code&state` | sets the session cookie, 302 to `returnTo` (or `/login?error=`) |
| POST | `/api/auth/logout` | – | ends the session |
| GET | `/api/projects/:id/access` | – | `{visibility, members[{userId, role, name, email}], invites, open, role}` |
| PUT | `/api/projects/:id/access` | `{visibility?, members?[{email, role}]}` | the same; people who never signed in are invited (`project.manage`) |
| GET | `/api/users` | – | people (admins) |
| PATCH | `/api/users/:id` | `{studioRole?, disabled?}` | the person (admins) |
| GET | `/api/tokens` | – | the caller's agent tokens (admins: all), without secrets |
| POST | `/api/tokens` | `{name, role, projectIds?, expiresInDays?}` | `201 {token, secret}` (signed-in people only; the secret is shown once) |
| DELETE | `/api/tokens/:id` | – | the token, revoked |
| GET | `/api/audit` | `?since&until&projectId&actor&type&limit` | audit events, newest first (admins; directors with their `projectId`) |

## Brand kits

[Brand kits](../design/brand-kits.md): the studio's kits, their files, and a project's brand.

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/brand-kits` | – | the kits |
| POST | `/api/brand-kits` | `{name, colors?, bug?, lowerThirds?}` | `201` the kit |
| PATCH | `/api/brand-kits/:id` | the same, partial | the kit (its author or an admin) |
| DELETE | `/api/brand-kits/:id` | – | `204`, with its files |
| PUT | `/api/brand-kits/:id/files/:slot` | multipart `file`; `slot`: `title_font`, `body_font`, `logo`, `intro`, `outro` | the kit; `422` for a file that is not a font (signature), an image or a video (probe), or a bumper over 30 s |
| GET | `/api/brand-kits/:id/files/:file` | – | the file |
| PUT | `/api/projects/:id/brand` | `{kitId \| null}` | `{brand}`: the kit applied (its files copied into the project's media), or removed (`project.manage`) |

Exports take `bug` (`POST /exports`, default: the brand's `bug.enabled`) to draw the brand bug.

## Agents

[Agents](../design/agents.md): recipes, variations of many shots, casting every voice.

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/recipes` | – | built-in and studio recipes |
| POST | `/api/recipes` | `{name, description?, params?, steps}` | `201` the recipe (validated against the MCP tools) |
| DELETE | `/api/recipes/:id` | – | `204`; built-ins `403`, others' recipes `403` unless admin |
| POST | `/api/projects/:id/recipes/:recipeId/run` | `{params}` | `202 Job` (`recipe.run`); the caller needs the strongest permission of its steps |
| POST | `/api/projects/:id/clips/:clipId/variations` | `{shotIds?, count: 2–4}` | `202 Job[]` (`shot.generate`, one per new take) |
| POST | `/api/projects/:id/voices/cast` | `{characterIds?, pick?, lock?}` | `202 Job` (`voices.cast`; `tts_unavailable` without TTS) |

## Interchange

[NLE interchange](../design/interchange.md): the cut (or the animatic) as a file for Premiere, Resolve, Final Cut Pro
or Avid, its clips pointing at the originals on WebDAV.

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/projects/:id/interchange.otio` | `?mediaBase&source=timeline\|animatic` | OpenTimelineIO (`Timeline.1` JSON), as a download |
| GET | `/api/projects/:id/interchange.fcpxml` | the same | FCPXML 1.10 |
| GET | `/api/projects/:id/interchange.xml` | the same | Final Cut Pro 7 XML (`xmeml` 5) for Premiere Pro and Resolve |
| GET | `/api/projects/:id/interchange.edl` | the same | CMX 3600 EDL of the picture |
| POST | `/api/projects/:id/interchange/import` | an `.otio` file (multipart `file`) or the OTIO JSON | `{clips, unresolved[{name, url}], skipped[], commit}`; the cut is replaced in one commit (`project.edit`) |

`mediaBase` is the WebDAV root as the editing machine sees it (a URL, or a mounted path such as
`/Volumes/dav/rideo`, which becomes a `file://` URL); the default is `features.interchange.mediaBase` of
`GET /api/config`. An empty cut is `409 conflict`; a file that is not an OTIO timeline, or whose clips are none of the
project's media, is `422 validation_error`.

## Review

[Review and approvals](../design/review.md): comments are `comments/<id>.json` and reviews `reviews/<id>.json`
documents, so they are also in `state`, history and live updates.

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/projects/:id/comments` | `?status=open\|resolved&target=take:<clipId>:<shotId>:<takeId>\|export:<exportId>` | threads, oldest first |
| POST | `/api/projects/:id/comments` | `{target, at?, annotation?: {shapes}, body}` | `201` the thread; `@` mentions of members notify them (`project.comment`) |
| POST | `/api/projects/:id/comments/:cid/replies` | `{body}` | `201` the thread (`project.comment`) |
| PATCH | `/api/projects/:id/comments/:cid` | `{status: "open" \| "resolved"}` | the thread; reviewers resolve their own threads, editors any |
| GET | `/api/projects/:id/reviews` | – | reviews, newest first |
| POST | `/api/projects/:id/reviews` | `{title, target: {kind: "export", exportId} \| {kind: "clip", clipId}, gate?, required?, link?: {expiresInDays?}}` | `201 {review, url}`: the share link's URL, once (`project.approve`) |
| POST | `/api/projects/:id/reviews/:rid/decisions` | `{decision: "approve" \| "changes", note?}` | the review; an approved review for a gate approves the gate when it can (`project.comment`) |
| DELETE | `/api/projects/:id/reviews/:rid/link` | – | the review, its link revoked (`project.approve`) |
| GET | `/api/review/:token` | – | guests: `{projectId, project: {title}, review (without its link), items[{key, label, target, media}], comments}` |
| GET | `/api/review/:token/media/*` | `Range` | guests: the review's videos and posters only |
| POST | `/api/review/:token/comments` | `{name, target, at?, annotation?, body}` | guests: `201` the thread, on what the review shows |
| POST | `/api/review/:token/comments/:cid/replies` | `{name, body}` | guests: `201` the thread |
| POST | `/api/review/:token/decisions` | `{name, decision, note?}` | guests: the review |
| GET | `/api/notifications` | `?limit` | `{notifications, unread}` of the caller, newest first |
| POST | `/api/notifications/read` | `{ids?}` | `{unread}`; all when `ids` is left out |

An unknown, malformed, wrong, revoked or expired review token is `404 not_found`; a guest comment on anything the
review does not show is `403 forbidden`.

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
| POST | `/api/projects/:id/uploads` | multipart `file`, optional `poster` (JPEG) and `meta` JSON `{probe, kind?, role?, name?}` (`probe`: `ProbeSchema`, made by the browser) | `Resource`: `ready` with a probe; otherwise `processing` + a `media.process` editor job; a `.cube` file is a `lut` resource (`application/x-cube`, validated: `422` when it is not a 3D LUT) |
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
| POST | `/api/projects/:id/clips/:clipId/generate` | – | `Job` (`clip.generate`: `shot.generate` per shot, or `shot.group` for consecutive shots of a multi-shot model unless `settings.generation.multiShot` is `off`, [multi-shot](../design/multi-shot.md)) |
| PATCH | `/api/projects/:id/clips/:clipId/shots/:shotId` | shot fields, including `camera.{lensMm, aperture, move}`, `startFrame`, `endFrame`, `motionReference`, `seed` ([directing](../design/directing.md)) | `Clip` |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/variations` | `{count: 2–4}` | `Job[]` (`shot.generate` with `variation`) |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/takes/:takeId/edit` | `{kind: "restyle" \| "relight" \| "replace" \| "angle" \| "remove", instruction}` | `Job` (`take.edit`, [take editing](../design/take-editing.md)) |
| POST | `/api/projects/:id/clips/:clipId/shots/:shotId/takes/:takeId/extend` | `{seconds: 1–10, prompt?}` | `Job` (`take.extend`) |
| POST | `/api/projects/:id/timeline/items/:itemId/extend` | `{edge: "start" \| "end", seconds: 1–5, prompt?}` | `Job` (`timeline.extend`) |
| POST | `/api/projects/:id/timeline/items/:itemId/mask` | `{subject?: "the person", invert?}` | `202 Job` (`mask.generate`): a matte of the subject becomes the video item's `mask` (`segmentation_unavailable`; items up to 2 minutes of source) |
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
| POST | `/api/projects/:id/timeline/assemble` | `{captions?, musicResourceId?}` | `{timeline, commit}` (with the default mix: ducking on) |
| POST | `/api/projects/:id/timeline/score` | `{direction?}` | `202 Job` (`score.generate`: a cue per scene on the Music track, [post audio](../design/post-audio.md)) |
| GET | `/api/projects/:id/subtitles.srt`, `/subtitles.vtt` | `?language=` | the cut's subtitles as text ([localization](../design/localization.md#subtitle-files)) |
| GET | `/api/projects/:id/localizations` | – | `Localization[]` with `state` (lines and dubs of the cut) |
| POST | `/api/projects/:id/localizations` | `{language, dub?, lipSync?}` | `202 Job` (`localize.generate`) |
| PATCH | `/api/projects/:id/localizations/:lang/lines` | `{shotId, index, text}` | `Localization` (the line marked `edited`) |
| DELETE | `/api/projects/:id/localizations/:lang` | – | `204` |
| POST | `/api/projects/:id/timeline/effects` | – | `202 Job` (`sfx.generate`; `sfx_unavailable`) |
| POST | `/api/projects/:id/analyses` | `{resourceId}` | `{analysis, job}` (`analysis.signals` editor job) |
| PATCH | `/api/projects/:id/analyses/:aid/suggestions` | `{decisions: [{id, status}]}` | `Analysis` |
| POST | `/api/projects/:id/analyses/:aid/auto-edit` | – | `{timeline, commit}` |
| POST | `/api/projects/:id/exports` | `{quality?, engine?: "auto" \| "ffmpeg" \| "webcodecs", source?: "timeline" \| "animatic", loudness?: "streaming" \| "broadcast" \| "off", stems?, language?, dubbed?, captions?: "burn" \| "sidecar", preset?, format?: "mp4" \| "prores" \| "frames", resolution?: "project" \| "hd" \| "uhd", fps?, aspect?: "source" \| "9:16" \| "1:1", maxDurationSec?, thumbnails?}` | `{export, job}` (the job is `export.prepare` when a reframe needs focus tracks first; the export records its resolved `delivery`, how it was enhanced and its `thumbnails`, [finishing](../design/finishing.md)) (`export.render` editor job; the export records `loudness`, with `stems` the three stem WAVs, `subtitles` (SRT and VTT) and, for a language variant, `language`, `dubbed` and its `renders/<id>.json` timeline) |
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
