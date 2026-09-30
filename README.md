# Rideo

Rideo is a web-based, all-in-one AI video generation and editing studio. You can
turn a short idea (plus optional reference images and videos) into a screenplay,
a locked cast of characters, and a movie of 40–60 minutes built clip by clip. You
can also upload existing footage and let the AI suggest and apply an edit.

| Capability | How Rideo does it |
|---|---|
| Asset management | Every project asset (screenplay, characters, clips, timeline, media) lives on a **WebDAV** store: an external server (OpenList, Nextcloud, Apache, rclone…) or the embedded `/dav` server. You can mount it in Finder or Explorer and edit it there. |
| Character consistency | A hard **consistency gate**. Characters are identity-locked with approved reference images, every generation is conditioned on those references, and every keyframe and clip is judged against them before it can enter the cut. See [docs/design/character-consistency.md](docs/design/character-consistency.md). |
| Version control | A git-like, content-addressed history (commits, branches, tags, diff, restore) stored next to the assets on WebDAV. |
| Generation | Images, video and music go through the [`@sloth-os/mm-gateway-js`](https://github.com/sloth-os/mm-gateway-js) SDK for [mm-gateway](https://github.com/sloth-os/mm-gateway). All other AI calls (LLM, vision, speech-to-text) go through the gateway's `/proxy/{domain}/{path}` reverse proxy. |
| Agent control | A built-in **MCP** server (`/mcp`) lets Claude Code or any MCP client drive the backend and the open browser UI. Every change appears live in the frontend. |
| Copyright | Every generated clip and export carries an **invisible watermark** (keyed DCT-domain payload) and provenance metadata. A detector recovers the brand and asset record. |
| Editing | The editor runs **in the browser**: [ffmpeg.wasm](https://ffmpegwasm.netlify.app) probes, analyzes, transcodes and renders, and **WebCodecs** (via [mediabunny](https://mediabunny.dev)) plays back and encodes in hardware. The server only watermarks and publishes the result. |

## Workflows

1. **Story → movie**: prompt (+image/+video) → screenplay and characters →
   fine-tune and approve → add resources (audio, music) → pilot clip
   (10 s–3 min) → fine-tune and approve → automatic generation of the remaining
   clips up to the target length (default 45 min, range 40–60 min) → review
   (regenerate clips) → edit → export.
2. **Footage → edit**: upload a video → AI analysis (scenes, silences, black
   frames, loudness, transcript, visual summary) → edit suggestions → auto edit →
   review → export.

Both workflows are declarative stage machines with approval gates. The UI, the
REST API and MCP tools all drive them. See [docs/design/workflows.md](docs/design/workflows.md).

## Quick start

Requirements: Node.js 24+, npm 11+, ffmpeg/ffprobe 4.4+ with libx264 (server side: generation and
watermarking), and a Chromium-, Firefox- or Safari-based browser with WebAssembly (the editor engine).

```bash
npm install
npm run dev:demo      # server + web + mock mm-gateway (fully offline demo)
# open http://localhost:5173
```

To use a real mm-gateway:

```bash
cp .env.example .env  # set MM_GATEWAY_URL, MM_GATEWAY_API_KEY, RIDEO_LLM_* ...
npm run dev           # server on :8787, web on :5173
```

Connect Claude Code to the running studio:

```bash
claude mcp add --transport http rideo http://localhost:8787/mcp
```

## Repository layout

```
packages/shared        domain schemas, timeline ops, workflow definitions, prompt compiler, watermark core
packages/server        Fastify API, WebDAV storage, version control, jobs, gateway + LLM clients, MCP, live sync
packages/web           React + Vite studio UI, WebCodecs preview/export
packages/mock-gateway  mm-gateway contract mock (REST + proxy LLM) for tests and the offline demo
e2e                    Playwright end-to-end tests
docs                   architecture and design documents (start here)
```

## Documentation

Start at [docs/README.md](docs/README.md).

## Development

```bash
npm run lint          # biome
npm run typecheck     # tsc --noEmit for every package and the e2e suite
npm run test:unit     # vitest unit suites
npm run test:integration   # server + embedded WebDAV + mock gateway + ffmpeg
npx playwright install chromium && npm run test:e2e   # Playwright (desktop + mobile viewports)
npm run build         # web app + bundled server and mock gateway (scripts/bundle.mjs)
```

Docker: `docker compose -f docker-compose.demo.yml up` runs the offline demo on http://localhost:8787;
see [docs/deployment.md](docs/deployment.md) for production with mm-gateway.

CI runs the same stages on GitHub Actions (`.github/workflows/ci.yml`).

## License

MIT
