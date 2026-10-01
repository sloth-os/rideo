# MCP server

Rideo embeds a [Model Context Protocol](https://modelcontextprotocol.io) server, so agents such as
Claude Code, Codex or Cursor can run a production end to end: create projects, write and edit screenplays,
lock characters, generate, review and approve clips, edit timelines, export, travel through history, and
drive the user's open browser. Every tool calls the same application services as the REST API, and every
resulting change streams live to the frontend.

## Transport and auth

- **Streamable HTTP** at `POST|GET|DELETE /mcp`, with stateful sessions (`Mcp-Session-Id`). Idle sessions are
  reaped after 30 minutes.
- When `RIDEO_API_TOKEN` is set, calls require `Authorization: Bearer <token>`.
- Clients that only support stdio can bridge with `npx mcp-remote http://HOST:8787/mcp`.

```bash
claude mcp add --transport http rideo http://localhost:8787/mcp \
  --header "Authorization: Bearer $RIDEO_API_TOKEN"
```

## Attribution and visibility

The MCP `initialize` request's `clientInfo.name` becomes the actor
`{kind: "agent", id: slug(name), name}`. Every commit made by a tool is authored by that actor, so history
shows "Claude Code: Lock character Mira". Every tool call also publishes an `activity` live event
(`{actor, tool, summary}`), and the UI shows it in the activity feed and as a toast, so the user can watch
the agent work.

## Results

Tools return `structuredContent` (JSON) plus the same JSON as a text block for clients that ignore
structured output. Failures return `isError: true` with `{code, message}` using the stable error codes of
the REST API (`validation_error`, `not_found`, `character_not_locked`, `character_locked`, `voice_not_locked`,
`voice_locked`,
`consistency_gate`, `gate_unmet`, `conflict`, `gateway_error`, …).

Long-running tools (`*_generate`, `batch_generate`, `export_render`, `footage_analyze`) enqueue a job and
return it immediately. Agents poll with `job_get` or block with `job_wait` (up to 120 s per call).

Media editing runs in the browser, so `export_render`, `footage_analyze` and `resource_add` (for audio and
video) create **editor jobs** that an open studio tab of the project runs
([editor](editor.md#editor-jobs)). Their results include `editorSessions` (tabs with an editor engine on
the project) and `waitingFor: "editor"` when there is none; an agent can ask the user to open the project
or keep going and `job_wait` until a tab picks the job up.

## Tool catalogue

### Projects, documents, workflow

| Tool | Arguments | Result |
|---|---|---|
| `project_list` | – | projects with kind, stage, progress |
| `project_create` | `kind`, `title`, `prompt?`, `targetDurationSec?`, `pilotDurationSec?`, `aspectRatio?`, `language?`, `autopilot?` | project |
| `project_get` | `projectId`, `include?[]` | project snapshot (documents, active jobs, workflow evaluation) |
| `project_update` | `projectId`, `title?`, `brief?`, `settings?` (deep-merged) | project |
| `project_sync` | `projectId`, `discardInvalid?` | WebDAV sync report |
| `doc_get` | `projectId`, `path`, `at?` (commit) | raw document |
| `workflow_status` | `projectId` | stage, gates, unmet requirements |
| `workflow_approve` | `projectId`, `gate` | new stage (or `gate_unmet` with details) |
| `workflow_reopen` | `projectId`, `stage` | new stage |

### Story, cast, resources

| Tool | Arguments |
|---|---|
| `screenplay_generate` | `projectId`, `prompt?`, `attachmentResourceIds?[]` → job |
| `screenplay_update` | `projectId`, `fields?` (title, logline, synopsis, genre, tone, style), `upsertScenes?[]`, `removeSceneIds?[]`, `outline?[]` |
| `screenplay_extend` | `projectId`, `beats?` → job |
| `character_create` | `projectId`, `name`, `role?`, `summary?`, `identity?`, `wardrobe?[]` |
| `character_update` | `projectId`, `characterId`, fields, `voice?: {description}` (rejected while locked) |
| `character_generate_refs` | `projectId`, `characterId`, `views?[]` → job |
| `character_add_reference` | `projectId`, `characterId`, `uri` (https or data URI), `view?`, `consent` (`{depictsRealPerson, subject?, grantedBy?, grantedAt?, scope?, evidence?}`) |
| `character_set_reference_approval` | `projectId`, `characterId`, `referenceId`, `approved` |
| `character_describe_from_image` | `projectId`, `characterId`, `resourceId`, `consent` → job |
| `character_lock` / `character_unlock` | `projectId`, `characterId` |
| `character_voice_design` | `projectId`, `characterId` → job (three previews, [dialogue](dialogue.md)) |
| `character_voice_select` | `projectId`, `characterId`, `candidateId` |
| `character_voice_clone` | `projectId`, `characterId`, `uri`, `consent` |
| `character_voice_lock` / `character_voice_unlock` | `projectId`, `characterId` |
| `element_list` | `projectId` |
| `element_create` | `projectId`, `kind` (`location`, `prop`, `style`), `name`, `description?`, `aliases?` |
| `element_update` / `element_delete` | `projectId`, `elementId`, fields (rejected while locked) |
| `element_generate_refs` | `projectId`, `elementId`, `views?[]` → job |
| `element_add_reference` | `projectId`, `elementId`, `uri`, `view?` |
| `element_set_reference_approval` | `projectId`, `elementId`, `referenceId`, `approved` |
| `element_lock` / `element_unlock` | `projectId`, `elementId` |
| `resource_add` | `projectId`, `uri`, `kind?`, `role?`, `name?` |
| `resource_list` | `projectId` |
| `music_generate` | `projectId`, `prompt`, `durationSec?`, `instrumental?` → job |

### Clips, shots, takes

| Tool | Arguments |
|---|---|
| `clip_plan` | `projectId`, `sceneId` → job |
| `clip_generate` | `projectId`, `clipId` → job |
| `shot_update` | `projectId`, `clipId`, `shotId`, `fields` |
| `shot_regenerate` | `projectId`, `clipId`, `shotId` → job |
| `take_select` | `projectId`, `clipId`, `shotId`, `takeId` |
| `take_override` | `projectId`, `clipId`, `shotId`, `takeId`, `reason` (requires `allowAgentOverrides`) |
| `clip_approve` | `projectId`, `clipId` (consistency gate R7) |
| `batch_generate` / `batch_pause` | `projectId`, `maxGenerations?` |

### Editing, analysis, export

| Tool | Arguments |
|---|---|
| `timeline_get` | `projectId` |
| `timeline_apply` | `projectId`, `ops[]` (the [timeline op](editor.md#operations) union) |
| `timeline_assemble` | `projectId`, `captions?`, `musicResourceId?` |
| `footage_analyze` | `projectId`, `resourceId` → `{analysis, job}` (editor job) |
| `suggestions_review` | `projectId`, `analysisId`, `decisions[{id, status}]` |
| `edit_auto` | `projectId`, `analysisId` |
| `export_render` | `projectId`, `quality?` (`draft`, `standard`, `high`), `engine?` (`auto`, `ffmpeg`, `webcodecs`) → `{export, job}` (editor job) |
| `export_list` | `projectId` |
| `watermark_detect` | `uri` or `projectId` + `mediaPath` → watermark, registry record and `contentCredentials` (C2PA) |

### History and jobs

| Tool | Arguments |
|---|---|
| `history_log` | `projectId`, `path?`, `limit?`, `before?` |
| `history_show` | `projectId`, `commit` |
| `history_diff` | `projectId`, `from`, `to` |
| `history_restore` | `projectId`, `commit`, `paths?[]` |
| `branch_list` / `branch_create` / `branch_switch` | `projectId`, `name?`, `from?` |
| `tag_create` | `projectId`, `name`, `commit?`, `message?` |
| `job_list` / `job_get` / `job_cancel` / `job_wait` | `projectId`, `jobId?`, `status?`, `timeoutSec?` |

### Frontend control

These tools act on the user's open browser tabs through the live channel (see
[realtime-sync](realtime-sync.md)). Without a `sessionId`, a command goes to every session viewing the
project. The result lists which sessions acknowledged it within 3 s.

| Tool | Arguments | Browser effect |
|---|---|---|
| `ui_sessions` | `projectId?` | – (lists sessions with route, selection, viewport, editor engine and current editor job) |
| `ui_navigate` | `projectId`, `view` (`overview`, `story`, `cast`, `elements`, `resources`, `clips`, `editor`, `analysis`, `history`, `exports`), `params?` | route change |
| `ui_focus` | `projectId`, `target {kind: scene, character, element, clip, shot, take, timeline-item, commit, job; id}` | scrolls to and highlights the entity |
| `ui_notify` | `message`, `level?`, `projectId?` | toast |
| `ui_player` | `projectId`, `action` (`play`, `pause`, `seek`), `time?` | editor/preview playback |

## Resources

| URI | Content |
|---|---|
| `rideo://projects` | project list (JSON) |
| `rideo://projects/{projectId}/state` | project snapshot (JSON) |
| `rideo://projects/{projectId}/screenplay.md` | screenplay rendered as Markdown |

## Example

```
> Create a 45 minute neo-noir film about a lighthouse keeper who receives letters from the future.
  Show me each step in my browser.

agent: project_create {kind: "story", title: "The Keeper", prompt: "...", targetDurationSec: 2700}
agent: ui_navigate {projectId, view: "story"}
agent: screenplay_generate {projectId} → job_wait
agent: workflow_approve {gate: "screenplay_approved"}          # when the user agrees
agent: character_generate_refs … character_lock … workflow_approve {gate: "cast_locked"}
agent: clip_generate {clipId: pilot} → job_wait → ui_focus {target: {kind: "clip", id}}
```
