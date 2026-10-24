# Deployment and configuration

Rideo needs almost nothing to start: with no configuration at all it serves the studio on port 8787, keeps
projects in each person's browser ([browser storage](design/browser-storage.md)) and works as an editor without AI.
Everything else (WebDAV, mm-gateway, models, voices, accounts, brand, provenance, limits, the theme) is set by an
administrator in **Settings** ([settings](design/settings.md)) and applied at once. The environment remains for what
the process needs before it can serve a page, and it can pin any setting (the UI then shows it locked).

## Docker Compose

```bash
cp .env.example .env                                 # optional: only what must be fixed before start
cp deploy/mm-gateway.example.yaml mm-gateway.yaml    # gateway backends, proxies and keys
docker compose up -d        # rideo on :8787 (UI, API, /mcp, /dav) + mm-gateway
```

Then open the studio, go to Settings (the gear in the header) and choose where projects are stored and which models
to use. `docker-compose.yml` sets `MM_GATEWAY_URL` to the compose service, so the gateway shows as set by the
environment.

`docker-compose.yml` runs `ghcr.io/sloth-os/rideo` next to `ghcr.io/sloth-os/mm-gateway` (config mounted at
`/etc/mm-gateway/config.yaml`). For a fully offline demo, `docker compose -f docker-compose.demo.yml up`
swaps mm-gateway for the mock gateway, which ships in the same image
(`node packages/mock-gateway/dist/main.js`). Both services build from the `Dockerfile` when the image is
not available locally or on GHCR.

The image runs as the `node` user under `tini`, keeps its data on the `/data` volume, logs JSON (pino) and
reports health through `/api/health`. CI publishes `ghcr.io/sloth-os/rideo:latest` and `:<sha>` from
`main`.

The image contains ffmpeg (used by the server only for generated takes and the watermark) and the built web
app, including the ffmpeg.wasm core (31 MB, served from `/assets/` with immutable caching; no cross-origin
isolation headers are needed for the single-threaded core). Projects live where `RIDEO_STORAGE` says: on the
WebDAV store, in the built-in one, or in people's browsers. `RIDEO_DATA_DIR` (`/data`) holds the settings file
(`settings.json`, secrets included: keep the volume private), the embedded WebDAV root (studio-wide data such as
accounts and brand kits when projects live in browsers), the media cache, the editor-job staging area and, without a
configured certificate, the development C2PA signer.

## Behind a reverse proxy, under a subpath

Rideo can be served under a path of another site (`https://example.com/rideo/`) behind Caddy, nginx or Apache
httpd, with the prefix stripped by the proxy or kept. Set `RIDEO_PUBLIC_URL=https://example.com/rideo` (or
`RIDEO_BASE_PATH=/rideo`), or let the proxy send `X-Forwarded-Prefix`. Ready-made configurations are in
`deploy/caddy/Caddyfile`, `deploy/nginx/rideo.conf` and `deploy/httpd/rideo.conf`; see
[serving under a subpath](design/subpath.md).

## Environment

Every variable below is read from the environment (and `.env`). Those that also appear in the
[settings table](design/settings.md#the-settings-table) (most of them) can be set in **Settings** instead: a variable
that is set in the environment wins and shows locked there; one that is not can be changed in the UI and is kept in
`<RIDEO_DATA_DIR>/settings.json`. Variables marked *environment only* cannot be set in the UI.

### Server

| Variable | Default | Meaning |
|---|---|---|
| `RIDEO_HOST` / `RIDEO_PORT` | `0.0.0.0` / `8787` | listen address (*environment only*) |
| `RIDEO_PUBLIC_URL` | `http://localhost:8787` + the base path | external base URL, with the subpath (links in MCP results, share links, the OIDC redirect URI) (*environment only*) |
| `RIDEO_BASE_PATH` | the path of `RIDEO_PUBLIC_URL` | serve under a subpath, e.g. `/rideo` ([subpath](design/subpath.md)); a proxy's `X-Forwarded-Prefix` overrides it per request (*environment only*) |
| `RIDEO_CORS_ORIGINS` | – | comma-separated origins (or `*`) whose pages may use this server through the studio library ([embedding](design/embedding.md#talking-to-a-server-on-another-origin)) |
| `RIDEO_THEME` | – | the studio theme as JSON: default mode, colors, fonts, radii, brand ([themes](design/embedding.md#themes)) |
| `RIDEO_API_TOKEN` | – | bearer token for `/api`, `/api/live`, `/mcp` (unset = open, for local use); with accounts it stays a studio token acting as the configured user with admin rights (*environment only*) |
| `RIDEO_OIDC_ISSUER` | – | accounts ([accounts](design/accounts.md)): the OpenID Connect issuer; people sign in through it and the redirect URI is `RIDEO_PUBLIC_URL/api/auth/callback` |
| `RIDEO_OIDC_CLIENT_ID` / `RIDEO_OIDC_CLIENT_SECRET` | – | the client registered at the issuer (no secret: a public client with PKCE) |
| `RIDEO_OIDC_SCOPES` / `RIDEO_OIDC_NAME` | `openid profile email` / `your identity provider` | requested scopes; the provider's name on the sign-in button |
| `RIDEO_ADMINS` | – | comma-separated emails of administrators |
| `RIDEO_OIDC_ALLOWED_DOMAINS` | – | comma-separated email domains that may join (empty: anyone the provider signs in) |
| `RIDEO_SESSION_DAYS` | `14` | sign-in session lifetime (renewed on use) |
| `RIDEO_USER_ID` / `RIDEO_USER_NAME` | `local` / `You` | actor for REST calls (the id is *environment only*) |
| `RIDEO_DATA_DIR` | `./data` | settings, embedded WebDAV root (studio data in browser mode) and caches (*environment only*) |
| `RIDEO_CACHE_MAX_BYTES` | `5368709120` | local media cache cap |
| `RIDEO_WEB_DIST` | `packages/web/dist` | built UI served at the base path (*environment only*) |
| `RIDEO_VAPID_PUBLIC_KEY` / `RIDEO_VAPID_PRIVATE_KEY` | – (made once, `<dataDir>/push/vapid.json`) | the Web Push key pair (P-256, base64url) of [the installable app](design/pwa.md); set both to keep it across data dirs (*environment only*) |
| `RIDEO_VAPID_SUBJECT` | `mailto:rideo@localhost` | the contact push services see (`mailto:` or `https:`) |
| `RIDEO_CROSS_ORIGIN_ISOLATION` | `require-corp` | the studio's `Cross-Origin-Embedder-Policy` (with `Cross-Origin-Opener-Policy: same-origin`): cross-origin isolation, so ffmpeg.wasm runs multi-threaded ([engine performance](design/engine-performance.md)); `credentialless`, or `off` to send neither |
| `RIDEO_LOG_LEVEL` | `info` | pino level (*environment only*) |

### Storage

| Variable | Default | Meaning |
|---|---|---|
| `RIDEO_STORAGE` | `auto` | where projects live: `browser` (each person's browser, [browser storage](design/browser-storage.md)), `webdav` (`RIDEO_WEBDAV_URL`), `embedded` (the built-in server at `/dav`, files in `RIDEO_DATA_DIR/dav`); `auto` = `webdav` with a URL, `embedded` when the built-in store already holds projects, else `browser` |
| `RIDEO_WEBDAV_URL` | – | external WebDAV base URL |
| `RIDEO_WEBDAV_USERNAME` / `RIDEO_WEBDAV_PASSWORD` | – | credentials for the external server |
| `RIDEO_WEBDAV_ROOT` | `/rideo` | root folder inside the share |
| `RIDEO_EMBEDDED_DAV` | `auto` | mount the built-in server at `/dav`: `auto` (with `embedded` storage) / `true` (also beside other storage) / `false` (*environment only*) |
| `RIDEO_DAV_USERNAME` / `RIDEO_DAV_PASSWORD` | – | Basic auth for the embedded `/dav` |
| `RIDEO_WEBDAV_SYNC_INTERVAL_SEC` | `15` | external-edit sync period for watched projects (0 = off) |
| `RIDEO_COALESCE_WINDOW_SEC` | `30` | commit coalescing window |

### mm-gateway

| Variable | Default | Meaning |
|---|---|---|
| `MM_GATEWAY_URL` | – | gateway base URL; unset: no AI, the editor works ([without mm-gateway](design/settings.md#without-mm-gateway)) |
| `MM_GATEWAY_API_KEY` | – | gateway bearer key |
| `MM_GATEWAY_ADMIN_KEY` | – (the gateway key is tried) | the gateway's management token (`MANAGEMENT_API_KEY`), used only to register the API keys set below as gateway proxies ([provider API keys](design/settings.md#provider-endpoints-and-api-keys)) |
| `MM_GATEWAY_ROUTING_PROFILE` | – | optional `routing.profile` |
| `RIDEO_IMAGE_MODEL` / `RIDEO_VIDEO_MODEL` / `RIDEO_MUSIC_MODEL` | `auto` | default models (projects can override; the pilot pins them) |
| `RIDEO_GATEWAY_POLL_MS` | `2000` | poll interval when there is no `Retry-After` |
| `RIDEO_GATEWAY_TIMEOUT_IMAGE_SEC` / `_VIDEO_SEC` / `_MUSIC_SEC` | `300` / `1200` / `600` | task timeouts |
| `RIDEO_LLM_PROVIDER` | `openai` | `openai` (or compatible), `gemini`, `anthropic` |
| `RIDEO_LLM_PROXY_DOMAIN` | provider default | the LLM's API base URL (`https://ai.example.com/v1`) or just its domain; the host is the gateway proxy ([API base URL](design/settings.md#api-base-url)) |
| `RIDEO_LLM_API_KEY` | – | the LLM's API key: registered in mm-gateway as a proxy account; empty: the gateway's own account for the domain |
| `RIDEO_LLM_MODEL` | `gpt-4.1-mini` | text model |
| `RIDEO_VISION_PROVIDER` / `_PROXY_DOMAIN` / `_API_KEY` / `_MODEL` | LLM values (the key of an endpoint with the same origin) | vision model for the judge and descriptions |
| `RIDEO_STT_PROXY_DOMAIN` / `_API_KEY` / `RIDEO_STT_MODEL` | – / – / `whisper-1` | optional speech-to-text (OpenAI-style) |
| `RIDEO_EMBEDDINGS_PROXY_DOMAIN` / `_API_KEY` / `RIDEO_EMBEDDINGS_MODEL` | – / – / `text-embedding-3-small` | optional caption embeddings: media search by meaning ([search](design/search.md)); without them it ranks by words |
| `RIDEO_TTS_PROVIDER` | `off` | dialogue voices ([dialogue](design/dialogue.md)): `elevenlabs` (design, clone, speech with timings), `openai` (preset voices) or `off`; new projects speak their dialogue when set |
| `RIDEO_SFX_PROVIDER` | `off` | generated sound effects ([post audio](design/post-audio.md)): `elevenlabs` (sound generation through the proxy) or `off` (`sfx_unavailable`) |
| `RIDEO_SFX_PROXY_DOMAIN` / `_API_KEY` / `RIDEO_SFX_MODEL` | `api.elevenlabs.io` / – / `eleven_text_to_sound_v2` | sound-effects endpoint behind the gateway proxy |
| `RIDEO_TTS_PROXY_DOMAIN` / `_API_KEY` / `RIDEO_TTS_MODEL` | provider default (`api.elevenlabs.io` / `eleven_multilingual_v2`, `api.openai.com` / `gpt-4o-mini-tts`) | TTS endpoint behind the gateway proxy |
| `RIDEO_EDIT_MODEL` | `auto` | video-to-video model of take edits ([take editing](design/take-editing.md)); projects can override `models.edit` |
| `RIDEO_PERFORMANCE_MODEL` | `auto` | model of performance takes ([performance](design/performance.md)): `auto` picks the first gateway model with `supports_performance`, `off` disables them; projects can override `models.performance` |
| `RIDEO_ENHANCE_MODEL` | `auto` | upscale and frame-interpolation model of exports ([finishing](design/finishing.md)): `auto` picks the first gateway model with the capabilities, `off` uses ffmpeg; projects can override `models.enhance` |
| `RIDEO_LIPSYNC_MODEL` | `auto` | video model of the lip-sync pass (projects can override `models.lipSync`) |
| `RIDEO_VOICE_JUDGE_PROVIDER` / `_PROXY_DOMAIN` / `_API_KEY` / `_MODEL` | the vision provider (none for Anthropic) / the vision base URL for the same provider, else the provider's / the key of an endpoint with the same origin / `gpt-4o-audio-preview` or `gemini-2.5-flash` | audio-capable model of the speaker check (rule V4); `off` disables it |

### Consistency, jobs, watermark

| Variable | Default | Meaning |
|---|---|---|
| `RIDEO_CONSISTENCY_JUDGE` | `vision-llm` | `vision-llm` or `off` (fail closed: takes become `unverified`) |
| `RIDEO_CONSISTENCY_THRESHOLD` | `0.75` | default threshold for new projects |
| `RIDEO_CONSISTENCY_MAX_ATTEMPTS` | `3` | default attempts per step |
| `RIDEO_LANES` | `control=16,llm=2,image=2,video=2,music=1,media=1` | job lane concurrency |
| `RIDEO_WATERMARK_KEY` | – (set it in production; otherwise one is generated once and kept in `RIDEO_DATA_DIR`) | secret key for the invisible watermark (*environment only*) |
| `RIDEO_WATERMARK_KEYS_OLD` | – | comma-separated retired keys still tried by detection (*environment only*) |
| `RIDEO_WATERMARK_STRENGTH` | `16` | embedding strength `T` |
| `RIDEO_BRAND_NAME` / `RIDEO_BRAND_OWNER` / `RIDEO_BRAND_URL` | `Rideo` / – / – | brand written into provenance and metadata |
| `RIDEO_FFMPEG_PATH` / `RIDEO_FFPROBE_PATH` | `ffmpeg` / `ffprobe` | binaries (generation and watermark) (*environment only*) |

### Provenance (C2PA)

| Variable | Default | Meaning |
|---|---|---|
| `RIDEO_C2PA` | `on` | sign takes and exports with C2PA Content Credentials ([provenance](design/provenance.md)) |
| `RIDEO_C2PA_CERT` / `RIDEO_C2PA_KEY` | – (development signer generated in `RIDEO_DATA_DIR/c2pa/`) | PEM certificate chain (leaf first) and private key, as file paths or PEM text |
| `RIDEO_C2PA_TSA_URL` | – | RFC 3161 time-stamp authority for signatures |
| `RIDEO_C2PA_TRUST_ANCHORS` | – | PEM bundle of CAs whose signatures the Verify page reports as `trusted` |
| `RIDEO_PUBLIC_DETECT_MAX_BYTES` | `536870912` | largest file the public detection endpoint accepts |

### Editor jobs

| Variable | Default | Meaning |
|---|---|---|
| `RIDEO_EDITOR_LEASE_SEC` | `60` | how long a tab holds an editor job without a heartbeat |
| `RIDEO_EDITOR_FILE_MAX_BYTES` | `4294967296` | largest file an editor job may stage (a render part, the soundtrack) |

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
and set `RIDEO_LLM_PROXY_DOMAIN=api.openai.com`. Proxies are registered at the API's origin: an API documented with a
base URL like `https://ai.example.com/v1` is proxied at `base_url: https://ai.example.com`, with
`RIDEO_LLM_PROXY_DOMAIN=https://ai.example.com/v1` (or `ai.example.com`; the same for `RIDEO_VISION_*`).

### Or set the API keys in Settings

Instead of writing provider credentials into the gateway's configuration, give Rideo the gateway's management token
(`MM_GATEWAY_ADMIN_KEY`, the gateway's `MANAGEMENT_API_KEY`) and set each provider's API base URL and API key in
**Settings → Language, vision and speech** (and **Voices and sound**). Rideo registers them in the gateway as proxies
tagged `rideo-<instance>`, with a gateway key of its own to use them, and removes them again when the keys are cleared
([registration in mm-gateway](design/settings.md#registration-in-mm-gateway)). The gateway needs its management API
(`MANAGEMENT_API_KEY` set; mm-gateway's Docker Compose setup has it) and, to keep the registrations across restarts,
`MANAGEMENT_CONFIG_PATH`; Rideo registers them again at every start in any case.

A model the gateway does not know yet is pinned on its backend and described in the gateway's catalog, so the
gateway lists it and Rideo plans shots it can render:

```yaml
backends:
  - { name: video, type: dashscope, base_url: "https://…", api_key: "${VIDEO_API_KEY}", tags: [prod],
      extra: { video_model: my-video-model } }
catalog:
  models:
    my-video-model: { modality: video, min_duration_seconds: 5, max_duration_seconds: 5 }
```

Then pin it in Settings (`RIDEO_VIDEO_MODEL`). The [real-model suite](testing.md#real-models-e2ereal) builds this
configuration from its variables.

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
- **C2PA certificate**: use a certificate from a CA on the C2PA trust list in production and set a
  time-stamp authority, so signatures stay valid after the certificate expires. The development signer in
  `RIDEO_DATA_DIR/c2pa/` is for local use only.
