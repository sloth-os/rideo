# Installable app (PWA)

Rideo installs on phones and desktops as an app (Add to Home Screen, Install): it opens without the browser's
chrome, starts from the home screen even offline, and tells people, through Web Push, when something waits for them
or an agent's work is done. The phone-first **Inbox** gathers what needs them across projects: reviews to decide,
gates to approve, agents and jobs to watch.

## The app shell

- **Manifest** (`/manifest.webmanifest`): name *Rideo Studio*, short name *Rideo*, `display: standalone`, the brand's
  background and theme colours (`#0B0D12`), the logo as SVG and as PNG icons (192 and 512 px, and maskable 512 px with
  the safe zone), and shortcuts to the Inbox and the projects.
- **Service worker** (`/sw.js`, scope `/`, served `no-cache` so updates arrive): it keeps the app shell, never live
  data:

| Request | Strategy |
|---|---|
| a page (navigation) | network first; offline, the cached shell (the app then says it is offline) |
| hashed build files (`/assets/…`) | cache first (they never change), except the ffmpeg.wasm cores (64 MB, the browser's HTTP cache keeps them) |
| `/api/…`, `/mcp`, `/dav/…`, media | never cached: always the network |

  A new version activates at once and the old caches are deleted.
- **Install**: where the browser offers it (`beforeinstallprompt`), the Inbox has *Install the app*; Safari on iOS
  shows how (Share → Add to Home Screen). Installed, the app follows the safe areas of the screen.

## The Inbox

`GET /api/inbox` (the signed-in person, or the studio) gathers, across the projects they may read:

| Section | What | Action |
|---|---|---|
| approvals | the current gate of each project, when its checks pass and the person may approve (`project.approve`) | *Approve* (`POST /api/projects/:id/workflow/approve`) |
| reviews | open reviews ([review](review.md)) the person is asked to decide | *Open* (the review on the project's overview) |
| jobs | jobs running now (with their progress and who started them: an agent, a person, Rideo) and jobs that failed in the last 24 hours | *Cancel* a running job (`project.edit`) |
| agents | the last 24 hours of agents' work: their commits (message, project, when) | *Open* the project's history |

It refreshes while open (every 15 s when visible, on focus, and when a notification arrives). The header has an
Inbox button with the number of approvals and reviews waiting, on phones too; on phones the Inbox also links to the
brand kits and the watermark check, which leave the header there.

## Notifications on the phone (Web Push)

Every notification ([review](review.md#notifications)) is also pushed to the person's devices that turned
notifications on, and there are notifications for agents' and people's long work:

| Notification | When | Opens |
|---|---|---|
| `job` *Export ready* / *Export failed* | an export finishes | Exports |
| `job` *Clip generated*, *Batch finished* / *… failed* | a clip or a batch of generation ends | Clips |
| `job` *Recipe finished* / *Recipe failed* | a recipe ends ([agents](agents.md#recipes)) | the project |
| `job` *Language version ready* / *… failed* | a language version is made ([localization](localization.md)) | Exports |
| `job` *… failed* | any other job that fails for good | the project |

They go to the person a job was for: the person who started it, or the one an agent or Rideo worked on behalf of.

- **Keys**: VAPID (RFC 8292): `RIDEO_VAPID_PUBLIC_KEY`, `RIDEO_VAPID_PRIVATE_KEY` (P-256, base64url) and
  `RIDEO_VAPID_SUBJECT` (`mailto:` or `https:`); without them the server makes a pair once and keeps it in
  `<dataDir>/push/vapid.json`.
- **Subscriptions**: `GET /api/push/key` (the public key), `POST /api/push/subscriptions` `{endpoint, keys: {p256dh,
  auth}}`, `DELETE /api/push/subscriptions` `{endpoint}`; kept per person (`<dataDir>/push/<userId>.json`, at most
  20 devices). The Inbox's *Notifications on this device* asks for the permission and subscribes.
- **Delivery**: each message is encrypted for the device (RFC 8291, `aes128gcm`: ECDH P-256, HKDF-SHA-256,
  AES-128-GCM) and posted to its push service with `TTL: 86400`, `Urgency: normal` (`high` for gates and reviews) and
  the VAPID `Authorization`. A device the push service no longer knows (404, 410) is removed. The payload is
  `{title, body, link, tag}` (≤ 3 KB); the service worker shows it and opens `link` (focusing the app when it is
  already open). `rideo_push_total{outcome}` counts deliveries (`sent`, `gone`, `failed`).
