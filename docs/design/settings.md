# Studio settings

Most of what used to live in the `.env` file is set in the studio itself: **Settings** (`/settings`, for
administrators) edits where projects are stored, the mm-gateway connection, the models, the language, vision and
speech providers (with their API keys), voices and sound effects, the consistency gate, accounts, the brand and
provenance, job limits and the studio's look. The environment keeps what the process needs before it can serve a page
(listen address, data directory, base path, the studio token) and can still pin any setting, which then shows as
locked in the UI.

## The settings table

Settings are declared once, as data, in `packages/shared/src/settings/index.ts`:

```ts
interface SettingField {
  env: string;            // the environment variable it stands for, and the key it is stored under
  group: SettingGroupId;  // storage, gateway, models, ai, audio, consistency, accounts, provenance, jobs, appearance
  label: string;
  help?: string;          // `code` in backticks is shown as code
  kind: 'text' | 'url' | 'secret' | 'number' | 'boolean' | 'select' | 'list' | 'pem' | 'theme';
  options?: readonly string[];                    // select
  optionLabels?: Readonly<Record<string, string>>; // select: what each option reads as ('' is "not set")
  placeholder?: string;                           // the documented default
  advanced?: boolean;                             // tucked under "Advanced" in its section
  showIf?: { env: string; in: readonly string[] };   // e.g. the WebDAV fields only when RIDEO_STORAGE=webdav
}
const SETTING_FIELDS: readonly SettingField[];
```

The server reads the table to know which keys the UI may set and which are secrets; the Settings page renders its
form from the same table, section by section. A setting is stored under its environment variable's name, so a value
means the same thing in `.env` and in the UI, and `loadConfig()` (`packages/server/src/config.ts`) stays the only place
that parses and derives configuration.

The AI endpoints reached through the gateway proxy are a second table, `SETTING_ENDPOINTS`
(`packages/shared/src/settings/endpoints.ts`): which settings make up each endpoint, which endpoint it falls back to,
and the provider APIs (`PROVIDER_APIS`: default domain, API version, credential header). The page draws one card per
endpoint from it and the server derives the endpoints, their keys and the gateway proxies from it
([provider endpoints and API keys](#provider-endpoints-and-api-keys)).

| Group | Settings (environment variables) |
|---|---|
| Storage | `RIDEO_STORAGE`, `RIDEO_WEBDAV_URL`, `RIDEO_WEBDAV_USERNAME`, `RIDEO_WEBDAV_PASSWORD`, `RIDEO_WEBDAV_ROOT`, `RIDEO_DAV_USERNAME`, `RIDEO_DAV_PASSWORD`, `RIDEO_WEBDAV_SYNC_INTERVAL_SEC`, `RIDEO_COALESCE_WINDOW_SEC` |
| mm-gateway | `MM_GATEWAY_URL`, `MM_GATEWAY_API_KEY`, `MM_GATEWAY_ADMIN_KEY`, `MM_GATEWAY_ROUTING_PROFILE`, `RIDEO_GATEWAY_POLL_MS`, `RIDEO_GATEWAY_TIMEOUT_IMAGE_SEC` / `_VIDEO_SEC` / `_MUSIC_SEC` |
| Models | `RIDEO_IMAGE_MODEL`, `RIDEO_VIDEO_MODEL`, `RIDEO_MUSIC_MODEL`, `RIDEO_EDIT_MODEL`, `RIDEO_LIPSYNC_MODEL`, `RIDEO_ENHANCE_MODEL`, `RIDEO_PERFORMANCE_MODEL` |
| Language, vision and speech | `RIDEO_LLM_PROVIDER` / `_PROXY_DOMAIN` / `_API_KEY` / `_MODEL`, `RIDEO_LLM_TIMEOUT_SEC`, `RIDEO_VISION_PROVIDER` / `_PROXY_DOMAIN` / `_API_KEY` / `_MODEL`, `RIDEO_STT_PROXY_DOMAIN` / `_API_KEY` / `_MODEL`, `RIDEO_EMBEDDINGS_PROXY_DOMAIN` / `_API_KEY` / `_MODEL` |
| Voices and sound | `RIDEO_TTS_PROVIDER` / `_PROXY_DOMAIN` / `_API_KEY` / `_MODEL`, `RIDEO_SFX_PROVIDER` / `_PROXY_DOMAIN` / `_API_KEY` / `_MODEL`, `RIDEO_VOICE_JUDGE_PROVIDER` / `_PROXY_DOMAIN` / `_API_KEY` / `_MODEL` |
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

## The Settings page

The page answers three questions in order: *is the studio working* (the status row), *where is the setting I want*
(the section list and search) and *what will my change do* (the field, its source and the save bar).

```
┌ Settings ─────────────────────────────────────────── [ Find a setting… ] ┐
│ [Storage ✓ WebDAV server] [mm-gateway ✓ Connected] [Language, vision… ⚠ 1 needs attention] │
├──────────────┬──────────────────────────────────────────────────────────┤
│ Storage      │ Language, vision and speech                              │
│ mm-gateway   │ ┌ Text model ───────────────── ✓ Key registered [Test] ┐ │
│ Models       │ │ Provider [OpenAI or compatible]  Model [qwen3.8-max]  │ │
│▸Language…  ⚠ │ │ API base URL [https://ai.example.com/v1           ]   │ │
│ Voices… (2)  │ │ API key [•••• set] [Replace] [Remove]                 │ │
│ …            │ └────────────────────────────────────────────────────────┘ │
│              │ ┌ Vision ─────────────────── ✓ Uses the text model's key ┐ │
└──────────────┴──────────────────────────────────────────────────────────┘
                                   2 unsaved changes   [Discard] [Save and apply]
```

- **Status row**: where projects are stored, whether mm-gateway is connected, and the AI endpoints in one line
  (*3 endpoints ready*, *1 needs attention*, or *Off until mm-gateway is connected*). Each tile opens its section.
- **Sections**: one section at a time. On a desktop (`≥ 768px`) the sections are a sticky list beside the content;
  on a phone they are a row of tabs that scrolls sideways inside itself (the page never does). Each entry shows a
  count of its unsaved changes and a warning dot when something in it needs attention (an endpoint that cannot be
  reached, a field the server refused). The section is in the URL hash (`/settings#ai`; the old
  `#settings-<group>` links still work), so a link such as *Connect mm-gateway in Settings* opens the right one.
- **Search**: typing in *Find a setting* shows every matching setting across sections (label, variable name, help),
  grouped by section, and clears back to the section that was open.
- **Fields**: label, the variable name in small monospace (it is what `.env` uses), the control, the help (with
  `code` shown as code) and the field's state: *set by the environment* (locked, read-only), *unsaved*, or *Use the
  default* for a stored value. Rarely changed settings (`advanced: true`: intervals, timeouts, lanes, byte limits,
  OIDC scopes) sit under an *Advanced* disclosure that opens by itself when one of them is changed, locked, refused
  or matched by the search.
- **Secrets** are never sent to the browser. A stored secret reads *Set* with **Replace** (an empty input that takes
  the new value, with a show/hide toggle) and **Remove** (clears it on save, with *Undo*).
- **Endpoint cards** (Language, vision and speech; Voices and sound): one card per endpoint with its provider, model,
  API base URL and API key, what the studio will call (*`https://ai.example.com/v1/chat/completions` through the
  gateway proxy `ai.example.com`*), its status from the server and a **Test** button
  ([below](#provider-endpoints-and-api-keys)). Optional endpoints say what turns them on (*Empty: footage is
  analyzed without a transcript*).
- **Checks before saving**: numbers, URLs and API base URLs are checked as they are typed and explained under the
  field; the server's validation stays the authority. A refused save opens the first section with an error.
- **Save bar**: the number of unsaved changes, **Discard** and **Save and apply**. When jobs are running, saving
  asks first (they are interrupted and resume). After saving, a toast says what was applied and whether the API keys
  were registered in mm-gateway.

## Provider endpoints and API keys

Every language, vision and speech call goes through the gateway proxy, `{MM_GATEWAY_URL}/proxy/{domain}/{path}`
([AI gateway](ai-gateway.md#proxy-usage-llm-vision-stt-embeddings)); Rideo never calls a provider. An endpoint is
reached in one of two ways:

1. **The gateway's own account**: the gateway's operator configured a proxy for the domain with its credential, and
   the API key field stays empty (how every deployment worked before).
2. **An API key set in Settings**: Rideo registers the key in mm-gateway as a proxy account through the gateway's
   management API, so the key still lives in the gateway and requests never carry it.

### Endpoints

| Endpoint | Settings | Falls back to | Off when |
|---|---|---|---|
| Text model (`llm`) | `RIDEO_LLM_PROVIDER`, `_PROXY_DOMAIN`, `_API_KEY`, `_MODEL` | – | no gateway |
| Vision (`vision`) | `RIDEO_VISION_*` | the text model (provider, base URL, model) | no gateway |
| Speech-to-text (`stt`) | `RIDEO_STT_PROXY_DOMAIN`, `_API_KEY`, `_MODEL` (OpenAI-style) | – | no base URL |
| Embeddings (`embeddings`) | `RIDEO_EMBEDDINGS_PROXY_DOMAIN`, `_API_KEY`, `_MODEL` (OpenAI-style) | – | no base URL |
| Dialogue voices (`tts`) | `RIDEO_TTS_PROVIDER`, `_PROXY_DOMAIN`, `_API_KEY`, `_MODEL` | the provider's defaults | `off` |
| Sound effects (`sfx`) | `RIDEO_SFX_PROVIDER`, `_PROXY_DOMAIN`, `_API_KEY`, `_MODEL` | `api.elevenlabs.io` | `off` |
| Speaker check (`voiceJudge`) | `RIDEO_VOICE_JUDGE_PROVIDER`, `_PROXY_DOMAIN`, `_API_KEY`, `_MODEL` | vision (not Anthropic) | `off` |

| Provider | Label | Default domain | API version | Credential header |
|---|---|---|---|---|
| `openai` | OpenAI or compatible | `api.openai.com` | `v1` | `authorization: Bearer <key>` |
| `gemini` | Google Gemini | `generativelanguage.googleapis.com` | `v1beta` | `x-goog-api-key: <key>` |
| `anthropic` | Anthropic | `api.anthropic.com` | `v1` | `x-api-key: <key>` |
| `elevenlabs` | ElevenLabs | `api.elevenlabs.io` | `v1` | `xi-api-key: <key>` |

### API base URL

`RIDEO_*_PROXY_DOMAIN` takes the **API base URL** as the provider documents it (`https://api.openai.com/v1`,
`https://dashscope.aliyuncs.com/compatible-mode/v1`, `https://ark.cn-beijing.volces.com/api/v3`) or, as before, just
its domain (`api.openai.com`). `parseApiBase()` (shared) turns it into:

| Value | `domain` (the proxy) | `origin` | Path of `v1/chat/completions` |
|---|---|---|---|
| `api.openai.com` | `api.openai.com` | `https://api.openai.com` | `v1/chat/completions` |
| `https://ai.example.com/v1` | `ai.example.com` | `https://ai.example.com` | `v1/chat/completions` |
| `https://ark.cn-beijing.volces.com/api/v3` | `ark.cn-beijing.volces.com` | `https://ark.cn-beijing.volces.com` | `api/v3/chat/completions` |
| `https://ai.example.com` | `ai.example.com` | `https://ai.example.com` | `v1/chat/completions` |
| `http://localhost:8080/v1` | `localhost` | `http://localhost:8080` | `v1/chat/completions` |

The base URL's path stands for the API version segment of the adapter's paths; a URL without a path (or a bare
domain) keeps the provider's version. A URL with credentials, a query or a fragment, or a scheme other than `http(s)`,
is refused under the field.

### Keys

- An endpoint uses its own key, else the key of the first endpoint in the table with the **same origin** that has
  one (the vision model shares the text model's key when both use `https://ai.example.com`, and so does speech-to-text
  when it uses the same API). The card says which (*Uses the text model's key*).
- Keys are secrets: masked in the view and the MCP tools, written to `settings.json` (mode `0600`) and to the
  gateway, never logged and never in the audit log (which records the variable names that changed).
- One gateway proxy fronts one domain. Two endpoints with keys on the same domain but different origins (another
  port or scheme) are refused when saving (`422`, under the second one's base URL).

### Registration in mm-gateway

With at least one key set, Rideo makes the gateway's configuration match, declaratively: the **desired proxies** are
derived from the endpoints (`desiredProxies()`), the **plan** compares them with the gateway's configuration
(`planProxySync()`, a pure function), and the plan's operations are applied through the management API of the
`@sloth-os/mm-gateway-ts` SDK (`ManagementApi`) with the configuration revision in `If-Match`. What Rideo creates is
named after the studio's **instance**, six hex digits generated once into `<RIDEO_DATA_DIR>/gateway.json` (mode
`0600`, with the token of the studio's gateway key):

| In mm-gateway | Value |
|---|---|
| Proxy `{domain}` | `base_url`: the origin; `tags`: `[rideo-<instance>]`; `timeout`: 600 s |
| Its accounts | one per distinct key: id `rideo-<instance>-<first 8 hex of sha256(key)>`, `headers`: the credential header of every provider that uses the key there |
| Key `rideo-<instance>` | the token from `gateway.json`, `allow_tags: [rideo-<instance>]`: the key the studio sends to the proxies it registered (other proxies get `MM_GATEWAY_API_KEY`) |

Rules of the plan:

- **Create** a proxy that does not exist. **Update** one that exists at the same origin: Rideo adds its accounts and
  its tag and keeps everything else (other accounts and headers are sent back as `[redacted]`, with the proxy's
  `domain`, which the gateway matches to keep them). A proxy only this studio uses (its tag alone, its accounts alone)
  moves when the base URL's origin changes. Anyone else's proxy at another URL, or one turned off, is a **conflict**:
  Rideo leaves it alone and the endpoint says why.
- An account whose id is already there with the same header names is left as it is (the id carries the key's
  fingerprint, so a new key is a new account), so a sync with nothing new writes nothing.
- **Remove** Rideo's accounts that are no longer wanted; a proxy left without accounts whose only tag is Rideo's is
  deleted, and the studio's key is deleted when no proxy is left.
- The studio's key is created when missing; when its token no longer works (a restored gateway, a new data
  directory), it is written again.

The admin token is `MM_GATEWAY_ADMIN_KEY` (the gateway's `MANAGEMENT_API_KEY`); empty, the gateway key is tried, which
works on gateways that use one token for both. A sync runs when the studio starts and after every saved change (the
save waits up to 20 s for it, so its answer has the result), and again before an endpoint test after a failure. Calls
to a domain being registered wait for the sync. Outcomes are counted in `rideo_gateway_proxy_sync_total{result}`
(`ok`, `conflict`, `failed`) and logged as `gateway proxies synced` (`{created, updated, removed, durationMs}`) or
`gateway proxy sync failed` (`{code}`).

| Sync failure (`code`) | Meaning |
|---|---|
| `gateway_admin_missing` | keys are set but there is no admin token (and no gateway key) to register them with |
| `gateway_admin_unauthorized` | the gateway refused the token (401/403) |
| `gateway_management_unavailable` | the gateway has no management API (404/405: management not enabled, or an older gateway) |
| `gateway_unreachable` | no answer from the gateway |
| `gateway_error` | anything else (the gateway's problem detail is shown) |

Changing the gateway URL leaves what was registered on the previous gateway as it is.

### Endpoint status and tests

`GET /api/settings` reports each endpoint (`endpoints.<id>`) with what it resolves to and how it is reached:

| `proxy` | Shown as | When |
|---|---|---|
| `off` | Off | not configured (or no gateway) |
| `registered` | Key registered in mm-gateway | its key is in the gateway's proxy for its domain |
| `gateway` | Uses mm-gateway's account | no key here; the gateway has a proxy for the domain |
| `missing` | No proxy in mm-gateway | no key here and the gateway has no proxy for the domain: add an API key |
| `unknown` | Through mm-gateway | no key here and no admin token to look (it may well work) |
| `pending` | Registering… | a sync is running |
| `conflict` / `failed` | the reason | registration was refused (above) |

**Test** (`POST /api/settings/test` with the endpoint's id as `target`) checks the **saved** settings (the card asks to
save first while it has unsaved changes) with the smallest real call through the proxy: a one-word completion for the
text, vision and speaker-check models (`rideo-task: settings.test`), half a second of silence for speech-to-text, one
embedding, and the provider's model list for voices and sound effects. It answers `{ok, detail, latencyMs}`: *qwen-max
answered in 0.8 s: “OK”*, or the gateway's or provider's refusal (*The provider refused the key (401)*, *mm-gateway
has no proxy for ai.example.com*).

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
| `GET /api/settings` | the view: every field of the table with `{value, source: "env" \| "settings" \| "default", locked, set}` (`value: null` for secrets, `set` tells whether one is stored), the resolved storage mode, `gateway`, `endpoints` (per endpoint: `{on, provider, url, domain, model, key: "own" \| "shared" \| "none", keyFrom, proxy, detail}`), `proxySync` (`{status: "idle" \| "pending" \| "ok" \| "failed", at, code, detail}`), `updatedAt`, `updatedBy`, `error` (an invalid file), `runningJobs` |
| `PUT /api/settings` | `{values: {<ENV_NAME>: string \| null}}`: a string sets, `null` clears back to the default, an omitted key (and an omitted secret) keeps its value. Unknown keys: 422 `validation_error`; locked keys: 409 `setting_locked`; values that fail `EnvSchema` or a cross-field rule (an issuer without a client id, `webdav` without a URL, an API base URL that does not parse, two keyed endpoints on one domain): 422 with `errors[{path: <ENV_NAME>, message}]`. Applies at once (below) and answers the new view with `{applied: true, changed}` |
| `POST /api/settings/test` | `{target: "webdav" \| "gateway", values}`: tries the connection with the values as they would be saved (WebDAV: list the root, write and delete a probe; gateway: health and the model catalogue) and answers `{ok, detail, models?}`; nothing is saved. `{target: <endpoint id>}`: tests that endpoint with the saved settings ([above](#endpoint-status-and-tests)) |
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
- The new studio registers the API keys in mm-gateway ([above](#registration-in-mm-gateway)); the save answers once
  that is done (or after 20 s, with `proxySync.status: "pending"`). A registration that fails does not undo the save:
  the settings are kept and the endpoints say what went wrong.
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
- API keys can be entered, but nothing is registered until a gateway is connected; the endpoints show *Off*.
