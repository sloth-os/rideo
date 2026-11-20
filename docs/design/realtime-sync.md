# Realtime sync

The frontend is a **projection** of server state. A change from any source (the user's own UI, another
tab, an MCP agent, a background job, an external WebDAV edit) reaches every open browser within
milliseconds, and MCP agents can also steer the UI itself.

## Channel

`GET /api/live` upgrades to a WebSocket (auth: `?token=` when `RIDEO_API_TOKEN` is set), under the studio's base
path when it has one ([subpath](subpath.md)). All messages are JSON and validated with the zod unions in
`shared/src/schemas/live.ts`. A settings change reloads the studio's services ([settings](settings.md#applying-a-change)):
the socket closes, the tab reconnects and, seeing a new `instanceId`, resyncs.

### Server → client

| Message | Meaning |
|---|---|
| `{type: "hello", sessionId, instanceId, serverTime}` | Sent on connect. `instanceId` changes on server restart, which tells clients to resync. |
| `{type: "event", projectId, seq, event}` | A project event (below). `seq` increases per project. |
| `{type: "resync", projectId, reason}` | The client must refetch `GET /api/projects/:id/state` (a sequence gap it cannot replay). |
| `{type: "ui", command}` | A UI command from an agent (below). |
| `{type: "notification", notification}` | Something for the person in this tab: a mention, a reply, a decision on their review, a gate approved through one ([review](review.md#notifications)). Sent to every tab of that person, whatever project it shows. |
| `{type: "storage", id, op, path, …}` | Browser storage: a storage operation on this browser's projects ([protocol](browser-storage.md#the-protocol)). |
| `{type: "workspace-ready", workspaceId, projects}` | The server has listed this browser's projects and serves them (after every attach). |
| `{type: "pong"}` | Heartbeat. |
| `{type: "job-heartbeat", jobId, leased, cancelled, leaseExpiresAt}` | The answer to a `job-heartbeat`: `leased: false` when the job is no longer leased to this session (the tab stops it), `cancelled` when it was cancelled. |

### Client → server

| Message | Meaning |
|---|---|
| `{type: "subscribe", projectId, lastSeq?}` | Start receiving events. With `lastSeq`, the server replays newer events from its ring buffer (the last 1000 per project), or sends `resync` when too far behind. With accounts the caller needs to read the project ([accounts](accounts.md)); otherwise the server answers `{type: "error", message: "forbidden: …"}`. |
| `{type: "unsubscribe", projectId}` | Stop. |
| `{type: "presence", projectId, route, selection?, viewport, engine?}` | What the user is looking at, and the tab's editor engine (`{ffmpeg, webcodecs: {video, audio}, busyJobId, threads, compositor, hidden}`: ffmpeg.wasm's threads, `webgpu` or `canvas` compositing, and whether the tab is hidden, [engine performance](engine-performance.md)). Agents read it with `ui_sessions`. Its project needs the same permission as `subscribe`: a tab claiming one it may not follow is answered `{type: "error", message: "forbidden: you may not follow …"}` and is present nowhere, so it gets nothing for that project ([who sees and steers which tabs](#who-sees-and-steers-which-tabs)). |
| `{type: "ui-ack", commandId, ok, error?}` | Acknowledges a UI command: `ok: false` with the reason when the tab did not carry it out. |
| `{type: "ping"}` | Heartbeat every 20 s; the server closes the socket after 60 s of silence. |
| `{type: "job-heartbeat", jobId, progress?}` | An editor job's heartbeat, sent by the tab that holds its lease (this session) every 10 s and with progress, like `POST /api/editor/jobs/:jobId/heartbeat` ([editor jobs](editor.md#editor-jobs)): it keeps the lease when the tab's HTTP requests are stuck behind media downloads. |
| `{type: "workspace", workspaceId, changed?}` | Browser storage: this tab serves its browser's projects; `changed` names projects it changed by itself (an import) ([protocol](browser-storage.md#the-protocol)). |
| `{type: "storage-result", id, ok, result?, data?, error?}` | The answer to a `storage` operation. |

## Project events

| `event.kind` | Payload | Client action |
|---|---|---|
| `commit` | `commit {id, message, author, timestamp, changes[], branch}`, `docs {[path]: doc \| null}` | replace or delete the changed documents in the store; append to the history panel |
| `job` | `job` (full record) | upsert into the jobs map (progress bars, queues) |
| `activity` | `{actor, action, summary, at}` | activity feed and toast (agent actions) |
| `head` | `{branch, commit}` | branch switched → refetch the state |
| `sync-issue` | `{path, error}` | WebDAV external edit could not be applied |

The payload of `commit` carries the full new documents, so the client does not need to refetch. When the
changed documents exceed 512 KiB, the server sends them with `docs: null` and the client fetches only
those paths.

### Ordering and consistency

- Events are published **after** the commit's ref update, in commit order. The per-project lock serializes
  commits, so `seq` order equals commit order.
- On reconnect the client resubscribes with its last `seq`. On a different `instanceId`, or after a
  `resync`, it reloads the snapshot and continues from the snapshot's `seq`, which `GET /state` returns.
- A page renders from `GET /state` alone; the recent history (`GET /history?limit=100`) arrives in the background and
  fills the History view and the activity when it does. The first history after a restart took 26.5 s on OpenList, and
  pages used to wait for both ([maintenance](storage-webdav.md#maintenance) also warms the log).
- UI mutations are not optimistic. The user's own REST call returns the commit, and the live event
  (usually first) applies it. Typing in text fields keeps local state and saves on debounce; if a remote
  commit changes a field the user has open and dirty, a "changed remotely" banner offers reload or keep.

## UI commands

```ts
type UiCommand = {
  id: string; issuedBy: Actor; projectId?: string; sessionId?: string;
  action: 'navigate' | 'focus' | 'notify' | 'player';
  params: { view?: View; params?: Record<string, string>;
            target?: { kind: FocusKind; id: string };
            message?: string; level?: 'info' | 'success' | 'warning' | 'error';
            playerAction?: 'play' | 'pause' | 'seek'; time?: number };
};
```

The web app maps commands to router navigation, element focus (the element with
`data-entity="<kind>:<id>"` is scrolled into view and pulses), toasts, or the editor player. It
acknowledges each command. `ui_*` MCP tools wait up to 3 s for acks and report `{delivered, acked}` per
session.

### Who sees and steers which tabs

A command goes to the tabs on its project: those subscribed to it or present on it. Outside auth mode `none`
([accounts](accounts.md), or the studio's API token) the `ui_*` tools never cross from one person's projects into
another's (`LiveHub.sendUi`, `UiService`):

- **Commands** reach only the tabs on their project, and their caller must be allowed to use that project: the tool
  asks `project.edit` of it (a recipe's run asked it when the run started, and its steps name the run's project,
  [recipes](agents.md#recipes)). A `sessionId` picks one of those tabs and never adds another: a tab elsewhere is not
  reached (`delivered: []`, the answer a session that does not exist gets too). `ui_notify` without a `projectId`
  reaches only the caller's own tabs (an agent token's: its owner's).
- **`ui_sessions`** lists the tabs the caller may see: their own, and those on projects they may read, each showing
  only those projects (`projectIds`, and `presence` when it is on one of them, else `null`). With a `projectId`, which
  the caller must read, it lists the tabs on that project and shows that project alone.
- **Presence** counts only on a project the tab may follow: a claim on another is refused like a `subscribe`, and the
  tab is present nowhere until its next claim, so it gets no command for that project.
- **The web app** carries out a command only for the project the tab shows (or one without a project): any other it
  leaves alone and acknowledges `ok: false` ("this tab shows another project"), whatever the server sends.

In auth mode `none` there is one person and every tab is theirs, as before: a `sessionId` reaches its tab wherever it is
(an agent can take the tab to a project it has just created), `ui_notify` without a project reaches every tab,
`ui_sessions` lists every tab with all its projects, and the web app carries out commands for any project.

## Presence

The browser sends `presence` on every route change and selection change, and whenever its editor engine
changes state. The hub keeps `{sessionId, projectId, route, selection, viewport, engine, connectedAt,
lastSeen}` so agents can ask "what is the user looking at?" (`ui_sessions`) and aim their commands. Claims are decided
in the order they arrive: a claim on a project the tab does not follow yet is checked first, and an older answer never
replaces a newer claim. Outside auth mode `none`, agents see only the tabs and projects they may
([above](#who-sees-and-steers-which-tabs)).

When a session disconnects, the editor jobs leased to it go back to `queued` at once (instead of waiting for
the lease to expire), and another tab of the project can resume them.
