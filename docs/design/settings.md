# Studio settings

Most of what used to live in the `.env` file is set in the studio itself: **Settings** (`/settings`, for
administrators) edits where projects are stored, the mm-gateway connection, the models, the language, vision and
speech endpoints, voices and sound effects, the consistency gate, accounts, the brand and provenance, job limits and
the studio's look. The environment keeps what the process needs before it can serve a page (listen address, data
directory, base path, the studio token) and can still pin any setting, which then shows as locked in the UI.

## The settings table

Settings are declared once, as data, in `packages/shared/src/settings/index.ts`:

```ts
interface SettingField {
  env: string;            // the environment variable it stands for, and the key it is stored under
  group: SettingGroupId;  // storage, gateway, models, ai, audio, consistency, accounts, provenance, jobs, appearance
  label: string;
  help?: string;
  kind: 'text' | 'url' | 'secret' | 'number' | 'boolean' | 'select' | 'list' | 'pem';
  options?: readonly string[];     // select
  showIf?: { env: string; in: readonly string[] };   // e.g. the WebDAV fields only when RIDEO_STORAGE=webdav
}
const SETTING_FIELDS: readonly SettingField[];
```

The server reads the table to know which keys the UI may set and which are secrets; the Settings page renders its
form from the same table, group by group. A setting is stored under its environment variable's name, so a value means
the same thing in `.env` and in the UI, and `loadConfig()` (`packages/server/src/config.ts`) stays the only place that
parses and derives configuration.

| Group | Settings (environment variables) |
|---|---|
| Storage | `RIDEO_STORAGE`, `RIDEO_WEBDAV_URL`, `RIDEO_WEBDAV_USERNAME`, `RIDEO_WEBDAV_PASSWORD`, `RIDEO_WEBDAV_ROOT`, `RIDEO_DAV_USERNAME`, `RIDEO_DAV_PASSWORD`, `RIDEO_WEBDAV_SYNC_INTERVAL_SEC`, `RIDEO_COALESCE_WINDOW_SEC` |
| mm-gateway | `MM_GATEWAY_URL`, `MM_GATEWAY_API_KEY`, `MM_GATEWAY_ROUTING_PROFILE`, `RIDEO_GATEWAY_POLL_MS`, `RIDEO_GATEWAY_TIMEOUT_IMAGE_SEC` / `_VIDEO_SEC` / `_MUSIC_SEC` |
| Models | `RIDEO_IMAGE_MODEL`, `RIDEO_VIDEO_MODEL`, `RIDEO_MUSIC_MODEL`, `RIDEO_EDIT_MODEL`, `RIDEO_LIPSYNC_MODEL`, `RIDEO_ENHANCE_MODEL`, `RIDEO_PERFORMANCE_MODEL` |
| Language, vision and speech | `RIDEO_LLM_PROVIDER` / `_PROXY_DOMAIN` / `_MODEL`, `RIDEO_VISION_PROVIDER` / `_PROXY_DOMAIN` / `_MODEL`, `RIDEO_STT_PROXY_DOMAIN` / `_MODEL`, `RIDEO_EMBEDDINGS_PROXY_DOMAIN` / `_MODEL` |
| Voices and sound | `RIDEO_TTS_PROVIDER` / `_PROXY_DOMAIN` / `_MODEL`, `RIDEO_SFX_PROVIDER` / `_PROXY_DOMAIN` / `_MODEL`, `RIDEO_VOICE_JUDGE_PROVIDER` / `_PROXY_DOMAIN` / `_MODEL` |
| Consistency | `RIDEO_CONSISTENCY_JUDGE`, `RIDEO_CONSISTENCY_THRESHOLD`, `RIDEO_CONSISTENCY_MAX_ATTEMPTS` |
| Accounts | `RIDEO_OIDC_ISSUER`, `RIDEO_OIDC_CLIENT_ID`, `RIDEO_OIDC_CLIENT_SECRET`, `RIDEO_OIDC_SCOPES`, `RIDEO_OIDC_NAME`, `RIDEO_ADMINS`, `RIDEO_OIDC_ALLOWED_DOMAINS`, `RIDEO_SESSION_DAYS`, `RIDEO_USER_NAME` |
| Brand and provenance | `RIDEO_BRAND_NAME`, `RIDEO_BRAND_OWNER`, `RIDEO_BRAND_URL`, `RIDEO_WATERMARK_STRENGTH`, `RIDEO_C2PA`, `RIDEO_C2PA_CERT`, `RIDEO_C2PA_KEY`, `RIDEO_C2PA_TSA_URL`, `RIDEO_C2PA_TRUST_ANCHORS`, `RIDEO_VAPID_SUBJECT` |
| Limits and embedding | `RIDEO_LANES`, `RIDEO_EDITOR_LEASE_SEC`, `RIDEO_EDITOR_FILE_MAX_BYTES`, `RIDEO_PUBLIC_DETECT_MAX_BYTES`, `RIDEO_CACHE_MAX_BYTES`, `RIDEO_CROSS_ORIGIN_ISOLATION`, `RIDEO_CORS_ORIGINS` |
| Appearance | `RIDEO_THEME` (the studio's [theme](embedding.md#themes)) |

**Environment only** (needed before the studio can serve the Settings page, or too dangerous to change from a web
page): `RIDEO_HOST`, `RIDEO_PORT`, `RIDEO_PUBLIC_URL`, `RIDEO_BASE_PATH`, `RIDEO_DATA_DIR`, `RIDEO_WEB_DIST`,
`RIDEO_LOG_LEVEL`, `NODE_ENV`, `RIDEO_API_TOKEN`, `RIDEO_USER_ID`, `RIDEO_EMBEDDED_DAV`, `RIDEO_FFMPEG_PATH`,
`RIDEO_FFPROBE_PATH` (a binary the server runs), `RIDEO_WATERMARK_KEY` and `RIDEO_WATERMARK_KEYS_OLD` (key material;
generated into the data directory when unset), `RIDEO_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` (likewise), and the test
switches `RIDEO_PUSH_ALLOW_HTTP`, `RIDEO_MEDIA_URI_MODE`, `RIDEO_JOB_RECOVERY`.

## Where values come from

```
effective value = environment (non-empty) ?? settings file ?? default
```

1. **Environment.** A variable that is set (and not empty) wins and locks the field: the UI shows its value (secrets
   masked) with "set by `MM_GATEWAY_URL`", read-only. Deployments that keep everything in `.env` work unchanged.
2. **Settings file.** `<RIDEO_DATA_DIR>/settings.json`, written by the Settings page (and the `settings_update` MCP
   tool): `{version: 1, updatedAt, updatedBy, values: {<ENV_NAME>: string}}`. Written atomically (temporary file,
   then rename) with mode `0600`, since it holds secrets.
3. **Default** from `EnvSchema`.

`loadConfig(env, overrides, settings)` merges `{...settings, ...nonEmpty(env)}` and parses the result with the same
`EnvSchema`, so a value from the file is validated exactly like one from the environment. The config remembers its
sources (`config.sources`) for the Settings view.

At start, `buildServer()` reads the file and builds the effective config. A file that no longer validates (edited by
hand, or an older value the schema now rejects) is not fatal: the studio starts on the environment alone, logs
`settings_invalid` and shows the error at the top of the Settings page until the values are fixed.

### Storage mode on first start

`RIDEO_STORAGE` is `auto` unless set, resolved at every start: `webdav` when `RIDEO_WEBDAV_URL` is set, `embedded`
when `RIDEO_EMBEDDED_DAV` is `true` or the embedded store (`<dataDir>/dav<root>/projects`) already holds projects (an
existing installation keeps its projects), else `browser` ([browser storage](browser-storage.md)). Settings shows the
resolved mode next to `auto`. Choosing a mode explicitly pins it.

## Surfaces

| Surface | What |
|---|---|
| `GET /api/settings` | the view: every field of the table with `{value, source: "env" \| "settings" \| "default", locked, set}` (`value: null` for secrets, `set` tells whether one is stored), the resolved storage mode, `updatedAt`, `updatedBy`, `error` (an invalid file) |
| `PUT /api/settings` | `{values: {<ENV_NAME>: string \| null}}`: a string sets, `null` clears back to the default, an omitted key (and an omitted secret) keeps its value. Unknown keys: 422 `validation_error`; locked keys: 409 `setting_locked`; values that fail `EnvSchema` or a cross-field rule (an issuer without a client id, `webdav` without a URL): 422 with `errors[{path: <ENV_NAME>, message}]`. Applies at once (below) and answers the new view with `{applied: true}` |
| `POST /api/settings/test` | `{target: "webdav" \| "gateway", values}`: tries the connection with the values as they would be saved (WebDAV: list the root, write and delete a probe; gateway: health and the model catalogue) and answers `{ok, detail, models?}`; nothing is saved |
| MCP `settings_get`, `settings_update` | the same service, with the same masking and validation ([MCP](mcp.md)) |

Only administrators may read or change settings: the studio principal (no accounts, or the studio token) and, with
accounts, people whose studio role is `admin`. Agent tokens never may (`forbidden`), whatever their owner's role.
Every change is recorded in the audit log as `settings.update` with the keys that changed (never the values).

## Applying a change

A saved change **reloads the studio in-process**: `StudioHost` (`packages/server/src/http/host.ts`) builds a new
studio (storage backend, gateway and proxy clients, LLM adapters, judges, job queue, live hub) from the new config,
stops the old one and swaps it in. Routes and MCP tools reach the studio through the host, so they use the new one
from the next request. The HTTP server, the WebSocket upgrade path and the embedded `/dav` mount (now mounted or not
by the new config) stay up.

- Open tabs see their live socket close and reconnect; the new `instanceId` makes them reload their snapshot
  ([realtime sync](realtime-sync.md#ordering-and-consistency)), and the app reloads `/api/config` so features that
  appeared or went away (a gateway was connected, a TTS provider chosen) show at once.
- Jobs running on the old studio are interrupted; the new one recovers them from their records, like after a restart
  ([generation pipeline](generation-pipeline.md)). The Settings page says how many jobs are running before saving.
- A reload that fails (the new storage cannot be reached, a certificate does not parse) rolls back: the previous
  settings are restored, the old configuration is rebuilt and the request answers 422 with the reason. A studio
  cannot lock its administrators out of Settings by saving a bad value.
- Reloads are serialized; the `rideo_settings_reloads_total{result}` counter and a `settings applied` log line
  (`{keys, durationMs}`) record each one.

## Without mm-gateway

`MM_GATEWAY_URL` has no default: until a gateway is configured the studio runs without AI and says so.

- `/api/config` reports `features.gateway: false` (and `features.ai: false`); `/api/ready` reports the gateway check
  as `{ok: true, detail: "not configured"}`, so a studio without a gateway is ready, not degraded.
- Everything the editor needs works: edit projects, uploads (probed and transcoded in the browser), footage analysis
  with rule-based suggestions, the timeline, transcript editing when a transcript exists, LUTs, keyframes, exports
  rendered in the browser and finished (watermark, Content Credentials) on the server, history, review and NLE
  hand-off.
- Work that needs a model fails fast with the typed error `gateway_not_configured` (409) instead of waiting for a
  connection timeout: screenplay and storyboard generation, references, clips and takes, music, voices, effects,
  translation and dubbing, masks, enhancement and search indexing by captions. The UI disables those actions with
  "Connect mm-gateway in Settings" (a link for administrators), and the dashboard offers footage edits first.
- Footage analysis skips the vision model and keeps the rule-based suggestions; speech-to-text is skipped.
