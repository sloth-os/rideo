# Realtime sync

The frontend is a **projection** of server state. A change from any source (the user's own UI, another
tab, an MCP agent, a background job, an external WebDAV edit) reaches every open browser within
milliseconds, and MCP agents can also steer the UI itself.

## Channel

`GET /api/live` upgrades to a WebSocket (auth: `?token=` when `RIDEO_API_TOKEN` is set). All messages are
JSON and validated with the zod unions in `shared/src/schemas/live.ts`.

### Server → client

| Message | Meaning |
|---|---|
| `{type: "hello", sessionId, instanceId, serverTime}` | Sent on connect. `instanceId` changes on server restart, which tells clients to resync. |
| `{type: "event", projectId, seq, event}` | A project event (below). `seq` increases per project. |
| `{type: "resync", projectId, reason}` | The client must refetch `GET /api/projects/:id/state` (a sequence gap it cannot replay). |
| `{type: "ui", command}` | A UI command from an agent (below). |
| `{type: "pong"}` | Heartbeat. |

### Client → server

| Message | Meaning |
|---|---|
| `{type: "subscribe", projectId, lastSeq?}` | Start receiving events. With `lastSeq`, the server replays newer events from its ring buffer (the last 1000 per project), or sends `resync` when too far behind. With accounts the caller needs to read the project ([accounts](accounts.md)); otherwise the server answers `{type: "error", message: "forbidden: …"}`. |
| `{type: "unsubscribe", projectId}` | Stop. |
| `{type: "presence", projectId, route, selection?, viewport, engine?}` | What the user is looking at, and the tab's editor engine (`{ffmpeg, webcodecs: {video, audio}, busyJobId}`). Agents read it with `ui_sessions`. |
| `{type: "ui-ack", commandId, ok, error?}` | Acknowledges a UI command. |
| `{type: "ping"}` | Heartbeat every 20 s; the server closes the socket after 60 s of silence. |

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

## Presence

The browser sends `presence` on every route change and selection change, and whenever its editor engine
changes state. The hub keeps `{sessionId, projectId, route, selection, viewport, engine, connectedAt,
lastSeen}` so agents can ask "what is the user looking at?" (`ui_sessions`) and aim their commands.

When a session disconnects, the editor jobs leased to it go back to `queued` at once (instead of waiting for
the lease to expire), and another tab of the project can resume them.
