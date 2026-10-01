# Architecture

## Goals and constraints

1. Assets are managed on **WebDAV**, so any WebDAV client or storage product can hold, browse and edit a
   project.
2. **Character consistency is guaranteed**: no take reaches an approved clip or an export unless its
   characters were verified against locked references, or a human recorded an explicit override.
3. Every document change is **versioned** (who, when, why) and can be diffed and restored.
4. Image, video and music generation uses the **mm-gateway JS SDK**. Every other AI request (LLM, vision
   judge, speech-to-text) goes through the **mm-gateway reverse proxy**.
5. Agents control the studio through **MCP**, and every change shows up **live** in open browsers.
6. Generated media carries **C2PA Content Credentials** and an **invisible, keyed watermark** plus
   provenance metadata, so it is detectable as AI-generated (EU AI Act Article 50); real people need
   consent records and force a visible disclosure label.
7. **Editing runs in the browser**: ffmpeg.wasm probes, analyzes, transcodes and renders, and WebCodecs
   plays back and encodes in hardware. The server never edits media; it keeps native ffmpeg only for the
   generation pipeline and the keyed watermark.

## System overview

```mermaid
flowchart LR
  subgraph Browser
    UI[React studio UI]
    ENG[Editor engine<br/>ffmpeg.wasm · WebCodecs/mediabunny]
    EJ[Editor-job worker]
  end
  subgraph Agents
    CC[Claude Code / MCP clients]
  end
  subgraph Rideo server
    REST[REST /api]
    LIVE[Live hub /api/live WS]
    MCP[MCP /mcp]
    SVC[Application services<br/>projects · story · clips · timeline · analysis · export · history · workflow]
    JOBS[Job queue + handlers<br/>server lanes · client lane]
    CONS[Consistency engine]
    WM[Watermark service]
    C2PA[Provenance: C2PA signer]
    MEDIA[Media toolkit ffmpeg<br/>generation + watermark only]
    VCS[Version store]
    STORE[Storage backend]
    DAV[Embedded WebDAV /dav]
    GW[Gateway client<br/>mm-gateway-js SDK]
    PX[Proxy client<br/>LLM · vision · STT]
  end
  subgraph External
    MMG[mm-gateway<br/>/v1/images · /v1/videos · /v1/music · /proxy]
    WEBDAV[(WebDAV server)]
  end
  UI -- fetch --> REST
  UI <-- events/ui commands --> LIVE
  ENG -- Range GET media --> REST
  EJ -- claim · heartbeat · files · complete --> REST
  CC -- Streamable HTTP --> MCP
  REST --> SVC
  MCP --> SVC
  SVC --> VCS --> STORE
  SVC --> JOBS --> CONS
  JOBS --> GW --> MMG
  CONS --> PX --> MMG
  JOBS --> MEDIA
  JOBS --> WM
  JOBS --> C2PA
  SVC -- events --> LIVE
  STORE -- WebDAV client --> WEBDAV
  STORE -. default .-> DAV
```

### Layers

| Layer | Package / module | Responsibility |
|---|---|---|
| Domain model | `packages/shared/src/schemas` | zod schemas for every document, event and API payload. They are the single source of truth for types. |
| Pure logic | `packages/shared/src/{timeline,workflow,prompt,watermark,diff,media}` | Timeline reducers, workflow stage tables, the deterministic prompt compiler, the watermark core (DCT embed/extract), and the media planners and parsers (probe banner, analysis log, media commands, render chunks and filtergraphs). No I/O, unit-tested, used by server and browser. |
| Application services | `packages/server/src/domain` | Use cases (create project, approve gate, generate clip…). Each takes an `Actor`, writes through the version store and emits live events. REST and MCP both call these. |
| Infrastructure | `packages/server/src/{storage,vcs,media,gateway,ai,jobs,watermark,provenance,live}` | WebDAV I/O, commits, ffmpeg, SDK/proxy clients, job execution, watermarking, WebSocket fan-out. |
| Surfaces | `packages/server/src/http`, `packages/server/src/mcp` | REST routes and MCP tools: thin adapters that validate input and call services. |
| UI | `packages/web` | Studio UI. Its state is a projection of server documents, updated by live events (timeline edits apply optimistically). |
| Editor engine | `packages/web/src/engine` | ffmpeg.wasm and WebCodecs media work: upload preparation, local proxies, analysis signals, chunked rendering, and the editor-job worker. |

## Data flow of a change

1. A surface (REST route, MCP tool, job handler, or WebDAV sync) calls a service method with an `Actor`.
2. The service takes the project's write lock, validates, and writes documents with `repo.commit()`. That
   stores content-addressed objects and moves the branch ref. See [version-control](design/version-control.md).
3. The work tree materializer writes human-readable copies of the changed documents to the project folder on
   WebDAV.
4. The live hub publishes `{kind: "commit", commit, docs}` to every subscribed browser session, with a
   per-project sequence number. See [realtime-sync](design/realtime-sync.md).
5. The browser store replaces the changed documents and React re-renders. Nothing is refetched unless a
   sequence gap is detected.

Long-running work (LLM calls, generation, watermarking) runs as **jobs**. Jobs publish `job` events for
progress and commit their results like any other actor (`system`, on behalf of the requesting actor).
Media editing work that nobody's browser has done yet (an MCP export, an inbox import) is an **editor
job** in the `client` lane: an open studio tab of the project claims it, runs it with its editor engine,
uploads the outputs and completes it. See [editor](design/editor.md#editor-jobs).

## Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere (Node 24 server, browser UI) | One type system; schemas and pure logic are shared between server and browser. |
| HTTP server | Fastify 5 + `@fastify/websocket` | Fast, schema-friendly, first-class `inject()` for tests. |
| Validation | zod 4 | Runtime validation at every boundary; MCP tool schemas come from the same definitions. |
| WebDAV client | `webdav` (perry-mitchell) | Mature client with streaming and ranges. |
| Embedded WebDAV | `webdav-server` v2 mounted at `/dav` via the HTTP server factory | Works with Finder, Explorer and davfs out of the box. |
| AI generation | `@sloth-os/mm-gateway-js` (OpenAPI SDK, pinned git dependency) | Required by the product constraints. |
| Other AI | `fetch` against `${MM_GATEWAY_URL}/proxy/{domain}/{path}` | Required by the product constraints. Supports streaming and abort. |
| MCP | `@modelcontextprotocol/sdk` Streamable HTTP transport | Supported by Claude Code, Codex, Cursor and others; stdio-only clients can use `mcp-remote`. |
| Browser media processing | ffmpeg.wasm (`@ffmpeg/ffmpeg` 0.12, FFmpeg 5.1 single-threaded core, self-hosted) | Every filter the editor needs (analysis, xfade, drawtext, amix…), any input codec, x264/VP8/VP9/AAC/Opus encoders. |
| Browser playback and fast encode | WebCodecs via mediabunny | Frame-accurate real-time decode and hardware-accelerated encode with a pure-TS demux/mux layer. |
| Server media processing | ffmpeg/ffprobe (child processes) | Generation only (judge frame samples, continuity frames, posters, cast sheets) and the watermark raw-frame pipes. |
| UI | React 19, Vite 8, Tailwind 4, zustand, react-router | Lightweight SPA; zustand store driven by live events. |
| Tests | Vitest (unit + integration), Playwright (e2e) | One runner for Node and jsdom, and a browser matrix for e2e. |
| Lint/format | Biome | A single fast tool. |

## Repository layout

```
.
├── packages
│   ├── shared/src
│   │   ├── schemas/        zod: media, project, screenplay, character, clip, timeline, resource, analysis, export, job, editor, vcs, events, live
│   │   ├── timeline/       ops reducer, queries, story assembly, suggestion application
│   │   ├── workflow/       declarative stage tables + evaluator
│   │   ├── prompt/         identity + shot prompt compiler
│   │   ├── watermark/      dct, prng, crc, payload, embed/extract (luma + rgba)
│   │   ├── provenance/     disclosure rule and label
│   │   ├── media/          probe banner parser, analysis log parser, media commands, render chunk planner + filtergraphs
│   │   └── diff/           json diff
│   ├── server/src
│   │   ├── storage/        backend interface, webdav + memory backends, embedded dav, layout
│   │   ├── vcs/            object store, repository, work tree
│   │   ├── media/          ffmpeg runner, probe, frames, posters, reference sheets (generation side)
│   │   ├── gateway/        SDK wrapper (images/videos/music/models), proxy client
│   │   ├── ai/             LLM adapters (openai/gemini/anthropic via proxy), prompts, structured output
│   │   ├── consistency/    judges + gate
│   │   ├── watermark/      frame pipeline, registry, detection
│   │   ├── provenance/     C2PA manifests (sign, read), development certificate
│   │   ├── jobs/           queue (server lanes + client lane with leases), persistence, handlers
│   │   ├── domain/         application services
│   │   ├── live/           event hub, sessions, UI command relay
│   │   ├── http/           routes
│   │   └── mcp/            MCP server + tools
│   ├── web/src             studio UI (features/*) and editor engine (engine/: ffmpeg.wasm, local proxies, analysis, rendering, editor jobs)
│   └── mock-gateway/src    mm-gateway contract mock
├── e2e                     Playwright specs
└── docs
```

## Non-goals (v1)

- Multi-tenant hosting. Rideo serves one studio; inside it, people sign in with the studio's identity provider and
  work on projects by role ([accounts](design/accounts.md)).
- Branch merge. Branches can be created, switched and cherry-picked per document with restore-from-commit.
- Multi-track video compositing (picture-in-picture). The timeline has one primary video track, plus text
  and audio tracks, so the WebCodecs compositor and the ffmpeg filtergraph stay WYSIWYG-identical.
- Headless media editing on the server. Editor jobs need an open studio tab; agents can drive one with
  the `ui_*` tools.
