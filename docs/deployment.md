# Deployment and configuration

## Docker Compose

```bash
cp .env.example .env        # fill in the values below
docker compose up -d        # rideo on :8787 (UI, API, /mcp, /dav) + mm-gateway
```

`docker-compose.yml` runs `ghcr.io/sloth-os/rideo` next to `ghcr.io/sloth-os/mm-gateway`. For a fully
offline demo, `docker compose -f docker-compose.demo.yml up` swaps mm-gateway for the mock gateway.

The image contains ffmpeg (x264, libvpx, opus, freetype) and the DejaVu fonts used by `drawtext`. All state
lives on the WebDAV store. `RIDEO_DATA_DIR` (`/data`) holds only the embedded WebDAV root (when used) and
the media cache.

## Environment

### Server

| Variable | Default | Meaning |
|---|---|---|
| `RIDEO_HOST` / `RIDEO_PORT` | `0.0.0.0` / `8787` | listen address |
| `RIDEO_PUBLIC_URL` | `http://localhost:8787` | external base URL (links in MCP results) |
| `RIDEO_API_TOKEN` | – | bearer token for `/api`, `/api/live`, `/mcp` (unset = open, for local use) |
| `RIDEO_USER_ID` / `RIDEO_USER_NAME` | `local` / `You` | actor for REST calls |
| `RIDEO_DATA_DIR` | `./data` | embedded WebDAV root and caches |
| `RIDEO_CACHE_MAX_BYTES` | `5368709120` | local media cache cap |
| `RIDEO_WEB_DIST` | `packages/web/dist` | built UI served at `/` |
| `RIDEO_LOG_LEVEL` | `info` | pino level |

### WebDAV

| Variable | Default | Meaning |
|---|---|---|
| `RIDEO_WEBDAV_URL` | – | external WebDAV base URL; empty = embedded `/dav` |
| `RIDEO_WEBDAV_USERNAME` / `RIDEO_WEBDAV_PASSWORD` | – | credentials for the external server |
| `RIDEO_WEBDAV_ROOT` | `/rideo` | root folder inside the share |
| `RIDEO_EMBEDDED_DAV` | `auto` | `auto` (on when no external URL) / `true` / `false` |
| `RIDEO_DAV_USERNAME` / `RIDEO_DAV_PASSWORD` | – | Basic auth for the embedded `/dav` |
| `RIDEO_WEBDAV_SYNC_INTERVAL_SEC` | `15` | external-edit sync period for watched projects (0 = off) |
| `RIDEO_COALESCE_WINDOW_SEC` | `30` | commit coalescing window |

### mm-gateway

| Variable | Default | Meaning |
|---|---|---|
| `MM_GATEWAY_URL` | `http://localhost:8000` | gateway base URL |
| `MM_GATEWAY_API_KEY` | – | gateway bearer key |
| `MM_GATEWAY_ROUTING_PROFILE` | – | optional `routing.profile` |
| `RIDEO_IMAGE_MODEL` / `RIDEO_VIDEO_MODEL` / `RIDEO_MUSIC_MODEL` | `auto` | default models (projects can override; the pilot pins them) |
| `RIDEO_GATEWAY_POLL_MS` | `2000` | poll interval when there is no `Retry-After` |
| `RIDEO_GATEWAY_TIMEOUT_IMAGE_SEC` / `_VIDEO_SEC` / `_MUSIC_SEC` | `300` / `1200` / `600` | task timeouts |
| `RIDEO_LLM_PROVIDER` | `openai` | `openai` (or compatible), `gemini`, `anthropic` |
| `RIDEO_LLM_PROXY_DOMAIN` | provider default | gateway proxy domain for the LLM |
| `RIDEO_LLM_MODEL` | `gpt-4.1-mini` | text model |
| `RIDEO_VISION_PROVIDER` / `_PROXY_DOMAIN` / `_MODEL` | LLM values | vision model for the judge and descriptions |
| `RIDEO_STT_PROXY_DOMAIN` / `RIDEO_STT_MODEL` | – / `whisper-1` | optional speech-to-text |

### Consistency, jobs, watermark

| Variable | Default | Meaning |
|---|---|---|
| `RIDEO_CONSISTENCY_JUDGE` | `vision-llm` | `vision-llm` or `off` (fail closed: takes become `unverified`) |
| `RIDEO_CONSISTENCY_THRESHOLD` | `0.75` | default threshold for new projects |
| `RIDEO_CONSISTENCY_MAX_ATTEMPTS` | `3` | default attempts per step |
| `RIDEO_LANES` | `control=4,llm=2,image=2,video=2,music=1,media=1` | job lane concurrency |
| `RIDEO_WATERMARK_KEY` | – (required in production; dev generates and stores one in `RIDEO_DATA_DIR`) | secret key for the invisible watermark |
| `RIDEO_WATERMARK_KEYS_OLD` | – | comma-separated retired keys still tried by detection |
| `RIDEO_WATERMARK_STRENGTH` | `10` | embedding strength `T` |
| `RIDEO_BRAND_NAME` / `RIDEO_BRAND_OWNER` / `RIDEO_BRAND_URL` | `Rideo` / – / – | brand written into provenance and metadata |
| `RIDEO_FFMPEG_PATH` / `RIDEO_FFPROBE_PATH` | `ffmpeg` / `ffprobe` | binaries |
| `RIDEO_FONT_FILE` | auto-detected DejaVu Sans | `drawtext` font |

## Connecting mm-gateway

Rideo needs image and video backends, plus a **proxy** entry for the LLM domain, in the gateway config:

```yaml
backends:
  - { name: vertex, type: vertex, tags: [prod] }            # Imagen / Veo / Lyria via ADC
proxies:
  - base_url: https://generativelanguage.googleapis.com     # RIDEO_LLM_PROVIDER=gemini
    tags: [prod]
    accounts: [ { id: main, headers: { x-goog-api-key: "${GOOGLE_API_KEY}" } } ]
keys:
  - { id: rideo, key: "${GATEWAY_API_KEY}", allow_tags: [prod] }
```

For OpenAI-compatible LLMs add `base_url: https://api.openai.com` with an `authorization: Bearer …` account
and set `RIDEO_LLM_PROXY_DOMAIN=api.openai.com`.

## External WebDAV examples

| Server | `RIDEO_WEBDAV_URL` |
|---|---|
| OpenList / AList | `https://files.example.com/dav` |
| Nextcloud | `https://cloud.example.com/remote.php/dav/files/<user>` |
| Apache mod_dav | `https://dav.example.com/` |
| rclone | `http://host:8080/` (`rclone serve webdav remote: --addr :8080`) |

## Operations

- **Health**: `/api/health` (liveness) and `/api/ready` (storage, gateway, ffmpeg and LLM checks).
- **Metrics**: `/metrics`. Jobs, gateway tasks, LLM calls, consistency outcomes, watermark operations,
  WebDAV latency, live sessions.
- **Logs**: JSON (pino) with `reqId`, `projectId`, `jobId` and `gatewayTaskId`.
- **Backups**: back up the WebDAV share. Everything, including version history, lives there.
- **Watermark key**: keep it secret and stable. After rotating, list the old key in
  `RIDEO_WATERMARK_KEYS_OLD` so earlier media still verifies.
