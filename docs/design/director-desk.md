# The 3D Director's Desk

A film made shot by shot loses its geography between cuts: the swimming demo's watermelon halves wandered from one
side of the beach to the other, and Rosie and Sammy changed places in a shot and its reverse shot. Previs tools stage a
scene in 3D first and lock the camera and the staging before the image and video models paint.

Rideo stages a scene on the **3D-Editor's director's desk**, embedded in the Storyboard view. The desk is another
application, served from its own origin and shown in an iframe. Rideo gives it a **brief** made from its own documents
(the scene, the cast, the props, every shot with its framing, lens, move and planned layout) and keeps the desk's
**state** for it; a person stages the scene there (figures that walk, sit, ride and hold props, a camera per shot), and
the desk renders each shot's **reference clip** in the browser. Rideo attaches the clip to the shot as its
[motion reference](directing.md#shot-controls) and takes the camera the desk staged (its lens and its move), so the
video model follows the staged motion or camera path.

The two share no code and no server. Everything they exchange goes through the **desk embed protocol, version 1**,
which the 3D-Editor owns ([docs/embedding.md](https://github.com/sloth-os/3D-Editor/blob/main/docs/embedding.md)).

## Why

Rideo had a desk of its own from October 2026 to November 14, 2026: a `SceneBlocking` document per clip, AI blocking
(the text model's floor plan, a camera solver, the 180° rule), a blocking line in every keyframe prompt and a flat
render of mannequins (the *camera view*) as one more reference image. On real models it did not help. The storyboards
scored 5.6–6.9 with it on against 7.1–7.3 off, the reviewers' blocking dimension 3–5; with the reference images
delivered (fp46) 7.00 against 7.27 off. The image model followed neither the mannequins nor the line, the AI blocking
took about ten minutes of reasoning per scene, and riders were drawn beside their ponies. New projects had it off from
October 30 ([the desk on request](first-pass.md#the-desk-on-request), the measurements in
[first pass](first-pass.md#measured)).

What a desk is good at is a person staging a scene in 3D and rendering its motion, and video models already take a
reference video for the motion, the poses or the camera's path (`reference_video`). The 3D-Editor's desk does the
staging well (articulated figures and animals, riders on their mounts, held props, physics, a catalog of models, a
camera per shot with checks of the line) and renders the passes the reference modes need. So rideo's own desk was
removed ([what happened to it](#what-happened-to-the-blocking)) and the 3D-Editor's is embedded: nothing about the desk
reaches a prompt but the shot's motion reference and its camera.

## What it is

| | Rideo | The desk |
|---|---|---|
| Owns | the brief (made from its documents), the desk state (stored as it is given, never read), the shots' motion references and cameras | the staging, the rendering and encoding of the clips, its working copy of the scene |
| Runs | the bridge in the studio tab (`postMessage` to the iframe), the desk-state and brief routes and one MCP tool on the server | in the iframe: in the browser, with no server of its own needed |
| Never | sends the desk a URL, a token or media (the units of the [library](#library-units) go as bytes in `open`); reads the state's bytes | calls rideo's server, sends anything rideo did not give it |

The desk is optional. Without [`RIDEO_DESK_URL`](#the-setting) there is no desk, and nothing else changes. It is a
person's tool in the browser; agents work from the same brief with the 3D-Editor's own MCP tools
([agents](#agents)).

## The setting

`RIDEO_DESK_URL` (Settings → **Limits and embedding**, group `jobs`, a URL field): the desk page, for example
`https://desk.example.com/desk.html`. Empty (the default): no desk, and the **Director's desk** buttons are not shown.
The URL must be `https:`, or `http:` on `localhost` or `127.0.0.1` for development (both pages must be
[secure contexts](#topology-and-headers)); its path is the page itself, not a folder. Like every setting, the
environment wins and locks the field ([settings](settings.md)). rideo's Docker Compose files run the 3D-Editor beside
the studio and set it to `http://127.0.0.1:8788/desk.html` for a studio opened on `http://localhost:8787`
([deployment](../deployment.md#the-directors-desk)).

Every browser reads it from `GET /api/config` as `features.desk: {url}` (`null` when unset): it is not a secret, and
the studio needs it before a person opens a project. The bridge takes the desk's origin from it once
(`new URL(url).origin`), posts only to that origin and accepts messages only from it. The desk needs no
`RIDEO_CORS_ORIGINS` entry, because it never calls rideo's API. The tab that saves the setting reloads its
configuration at once; other tabs see a changed URL when they load again.

## Topology and headers

**Its own host.** The desk is served from another host than rideo's (a subdomain is fine, `desk.example.com` beside
`studio.example.com`), never from a path of rideo's own origin and never from another port of rideo's host. On rideo's
origin, rideo's service worker deletes every other cache when it activates and caches navigations in its scope as
rideo's shell, the server answers unknown paths with rideo's `index.html`, and the desk would share rideo's
`localStorage` (where the session token is) and IndexedDB. Browsers keep cookies per host, not per port: rideo's
session cookie ([accounts](accounts.md), host-only) goes with every request to every port of rideo's host, the desk
page's and its own fetches included, so a desk there would receive it. With accounts on (`RIDEO_OIDC_ISSUER`) the
server refuses a `RIDEO_DESK_URL` whose host name is the one of `RIDEO_PUBLIC_URL` ("a desk on another host than the
studio's …").

**Headers on the desk page.** Rideo's pages are cross-origin isolated by default (`RIDEO_CROSS_ORIGIN_ISOLATION`:
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`,
[engine performance](engine-performance.md)). Under that policy a cross-origin iframe loads only when it says it may:
the desk page is served with `Cross-Origin-Embedder-Policy: require-corp` and
`Cross-Origin-Resource-Policy: cross-origin`, and with `Content-Security-Policy: frame-ancestors` listing rideo's
origins (and the pages that embed rideo through the [library](embedding.md), whose origin is the iframe's parent).
Without them the browser shows its own error page inside the iframe and rideo gets no error event, so the bridge gives
up after 15 seconds ([the desk in the studio](#the-desk)). The desk needs no `SharedArrayBuffer`, so the iframe gets no
`cross-origin-isolated` permission.

**The iframe.** `<iframe src="<RIDEO_DESK_URL>" title="3D director's desk" allow="fullscreen; clipboard-write;
screen-wake-lock" sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-modals allow-popups
allow-popups-to-escape-sandbox allow-pointer-lock">`. The sandbox gives the desk what it uses (scripts, its own
origin and so its storage and service worker, downloads, dialogs, pointer lock for the camera, links that open a new
tab) and nothing that reaches the studio: without `allow-top-navigation*` the desk cannot navigate the studio's tab
(an unsandboxed cross-origin frame can, after a click in it). `screen-wake-lock` lets the desk keep the screen awake
during a long export. Never the `credentialless` attribute (it would throw the desk's storage away).

**Secure contexts.** Both pages are HTTPS, or `http://localhost` / `http://127.0.0.1` in development: the desk encodes
its clips with WebCodecs and keeps files in the Origin Private File System, which exist only there. In development the
desk's dev server runs on the other of the two host names (a studio on `127.0.0.1` and the desk on `localhost`, as the
end-to-end tests do, or the reverse), not on another port of the studio's host, and sends the same two headers.

**Partitioned storage.** Inside rideo the desk's IndexedDB is partitioned by rideo's site: what a person staged in the
standalone desk is not seen inside rideo, and the reverse. The authoritative copy of a scene is the
[desk state](#the-desk-state) rideo stores; the desk's own copy is a cache that keeps the work between two stored
states.

## The protocol

The desk posts `hello` (the versions it speaks) to its parent once loaded. The bridge accepts it only from the
iframe's window and the desk's origin, with version 1 among its versions, creates a `MessageChannel` and posts
`connect` with the channel's second port; every later message travels on the port. The desk answers `ready` (its
version and whether this browser can encode the clips), rideo sends `open` with the brief, the stored state (or none)
and its options, and the desk answers `opened` (where the scene came from: the state, its local copy or the brief, and
how the brief differs from what was staged) and `state`. A desk that cannot read the state rideo handed over says so
first (`error` `state_unreadable`), opens its own copy of the scene, else stages the brief, and sends no `state` until
the person edits, so opening cannot replace rideo's copy.

| Rideo sends | When |
|---|---|
| `open` {`scene`: the [brief](#the-brief), `state`, `options`} | after `ready` and once the stored state was loaded ([a state that cannot be loaded](#when-rideo-stores-it) opens nothing), once per connection: a desk page that loads again says `hello` again, is connected again and gets the newest state the panel holds (the desk's newest `state`, else the stored state: `open` transfers a copy of its bytes and the panel keeps the original). `options` = `hostName` (the studio's brand name, `RIDEO_BRAND_NAME`, at most 40 characters), `modes` `["motion", "pose", "camera"]` (all three, in the protocol's order), `defaultMode` (the mode last attached in this project, *camera* when none: [which reference](#the-desk)), `readOnly` for an approved clip |
| `save` | when the person closes the panel: the desk answers `state` with the same `id` (rideo waits at most 5 seconds, then stores the newest state the desk sent); also when the person replaces a [kept](#when-rideo-stores-it) state and the desk sent none yet: rideo waits for the answer (or an `error`) however long the desk takes, and the first state that comes after Replace is stored at once |
| `export` | never on its own: the person presses **Send** in the desk |
| `result-ack` | after each `result`: what was attached and what was refused, shot by shot |
| `unit-ack` | after each `unit-publish`: whether the unit was saved to the library, its item and version, and whether it was linked ([publishing and linking](#publishing-and-linking)) |

With library units on, `open` also carries `options.units` and the pinned units (`units`), and `state` carries what
the scene uses (`units`): [library units](#library-units).

| The desk sends | Rideo |
|---|---|
| `ready` | sends `open`, with library units when `capabilities.units` allows them ([negotiation](#negotiation)); when `capabilities.export.available` is false, says why under the panel's title ("This browser cannot render the reference clips: …"): staging still works |
| `opened` | shows the desk ("Opened from the stored desk", "… from this browser's copy", "… from the brief") and keeps the shots the brief retimed (`changes.retimed`) for the refusals of [a result](#the-result) whose shot carries no `brief_length` issue; the desk itself lists the brief's changes and offers to update its shots (**Update shots**) |
| `state` | keeps the newest (a state of another scene is ignored), and stores it ([when](#when-rideo-stores-it)) |
| `progress` | shows the export's phase and count under the title |
| `result` | applies it ([the result](#the-result)) and answers `result-ack` |
| `error` | shows its message under the title; the errors meant for the person (`state_unreadable`, `export_failed`, `export_unavailable`, `out_of_memory`, `invalid_scene`) as a toast too, while the desk's answers to rideo's own requests (`not_open` for a `save` that came while the desk was still staging, `bad_message`, `unsupported_version`, `busy`, `cancelled`) go to the status line and the browser's console only. `state_unreadable` (the desk could not read the state rideo handed over) keeps the stored state: the panel says so with the desk's own message and stores nothing on its own ([a stored state that is kept](#the-desk)), in one toast however often the desk says it again (a desk page that loads again is handed the state again); `export_failed` after a `result` names the shots the desk left out of it |
| `close` | stores the last state (unless the stored one [is kept](#when-rideo-stores-it)) and closes the panel |
| `unit-publish` | saves the unit to the library, links it by the contract's rule and answers `unit-ack` ([publishing and linking](#publishing-and-linking)) |

Rideo speaks version 1. A desk that offers no version rideo speaks is not connected: "This desk speaks protocol
versions …; this studio speaks 1". Every message is validated with zod in both directions (`packages/shared`, the
schemas of the protocol and of the brief); a message of a type rideo does not know is ignored and logged, one that
does not validate is ignored and logged too, and one that carried an `id` is answered with `error` `bad_message`. A
`unit-publish` that does not validate is also answered `unit-ack` `{ok: false, code: "invalid"}` at once, since the desk
reads no `error` of the host and would wait out its timeout ([publishing and linking](#publishing-and-linking)). Text
the desk supplies (its versions, the reason export is unavailable, its errors' messages, the names of a result's files)
is cut to 300 characters wherever rideo shows it, in the status line and in toasts.
Rideo keeps a copy of the 3D-Editor's fixtures (one valid example of every message and some invalid ones) in
`packages/shared/test/fixtures/desk-protocol/`, and its tests parse every valid one and refuse every invalid one but
`state-units-bad-staged.json`, a state rideo reads with its units unknown ([what a stored state
uses](#what-a-stored-state-uses)), so a change on either side that breaks the other shows up in the tests.

## The brief

`deskBrief(docs, clipId)` (shared, pure) makes the `SceneBrief` of one clip; the same brief is sent to the desk and
served to agents. It is validated against the protocol's schema before it leaves rideo. A clip without shots has no
brief.

| Brief | From rideo | Rule |
|---|---|---|
| `id` | `clip.id` | the clip is the unit of the desk: one brief, one desk state, one desk project per clip |
| `name` | `clip.title` | cut to 200 characters; `Scene <n>` when empty |
| `fps` | `settings.fps` | integer 12–60: rideo's range, inside the protocol's 1–120 |
| `width`, `height` | `settings.resolution` | each rounded down to an even number (the clips are H.264 4:2:0): rideo's 64–4096 then fits the protocol's even 16–4096, and a result is checked against the rounded size |
| `set.description` | the scene (`clip.sceneId` in the screenplay) and its location element (`scene.locationId`) | the place (`scene.location`, else the location element's name, else `scene.heading`), the location element's `description` and the scene's `continuity` (time, weather, light, who wears and carries what), as sentences, cut to 4000 characters |
| `set.interior` | `scene.heading` | `INT.` true, `EXT.` false; `INT./EXT.`, `I/E`, `EST.` or none: null (the desk decides from the words) |
| `set.timeOfDay` | `scene.timeOfDay`, else the heading's time | the first that matches: dawn, sunrise, daybreak, first light, early morning → `dawn`; golden hour, magic hour → `golden_hour`; dusk, sunset, twilight, evening → `dusk`; night, nighttime, midnight → `night`; noon, midday → `noon`; afternoon → `afternoon`; morning → `morning`; anything else (`day`, `continuous`, `later`) → null (the desk's daylight) |
| `cast` | the characters of the clip's shots | in order of first appearance (shots by `index`), those in the project, at most 16 |
| `cast[].id`, `name` | `character.id`, `name` | |
| `cast[].description` | the identity and the summary | the identity as the video prompts say it (`compactIdentity`: age, gender, ethnicity, build, distinguishing marks, the default wardrobe), then `character.summary`, cut to 4000 characters: the words the desk reads the figure from ("a golden retriever", "a girl of 8") |
| `cast[].kind` | – | null: rideo has no species field, the desk reads it from the description |
| `cast[].heightM` | `identity.height` | a measure it names ("170 cm", "1700 mm", "1,700 mm", "1 700 mm", "1.2 m", "1,70 m", "1 m 70", "1 metre 70", "1m70", "5 ft 7 in", "5 ft 7", `5'7"`; a number after feet counts as inches only below 12, so "6 ft 180 lbs" is 1.83 m; a comma before three digits is a thousands separator, and so is a space (or a no-break or thin space) when a metric length follows the three digits, "1 700 mm"; where that reading gives no height in range the comma is a decimal comma, "1,750 m", and the space parts two numbers, "a girl of 8 120 cm" is 1.2 m; a space before three digits that no metric length follows always parts two numbers, so "5 ft 11 180 lbs" is 1.8 m and "1 m 70 120 lbs" 1.7 m), to the centimetre, 0.1–4 m; else null |
| `elements` | the scene's location, then the elements of the scene and of the clip's shots | in order of first appearance, those in the project, at most 64 |
| `elements[].kind` | `element.kind` | `location` → `location`, `prop` → `prop`, `style` → `other` (the desk stages no style) |
| `elements[].name`, `description` | `element.name`, `description` | |
| `shots` | `clip.shots` | sorted by `index` |
| `shots[].id` | `shot.id` | results name rideo's shots by it |
| `shots[].index` | its position | 0, 1, 2… in order |
| `shots[].durationSec`, `description`, `action`, `continuity` | the shot's | |
| `shots[].castIds`, `elementIds` | `characterIds`, `elementIds` | only those in the brief's cast and elements |
| `shots[].framing`, `movement` | `camera.framing`, `camera.movement` | the same words |
| `shots[].move`, `lensMm` | `camera.move`, `camera.lensMm` | null when unset; the move library is the same 20 moves ([directing](directing.md#move-library)) |
| `shots[].layout` | `shot.layout` | `characterId` → `castId`, entries whose character is in the shot's own `castIds` ([following the shot plan](#following-the-shot-plan)): a character taken out of a shot after planning (`shot_update` changes `characterIds`, never the layout) is not staged in it from a stale entry |
| `set.unit`, `cast[].unit`, `elements[].unit` | the entities' 3D pins | only in an open with library units, and then a figure pin also gives `cast[].kind` and `heightM` ([pins in the brief](#pins-in-the-brief)) |

Nothing else goes: no reference images, voices, lines, takes, frames, URLs or tokens. Rideo's ids (`clp_…`, `sht_…`,
`chr_…`, `ele_…`) fit the protocol's id pattern as they are.

## Following the shot plan

The shot planner writes, beside each shot's description, its **planned layout** (`shot.layout`): every character in
frame with the side of the frame they are on (`left`, `centre`, `right`) and which way they face in the picture
(`left`, `right`, `camera`, `away`), as the description says it. The brief carries it as the shot's `layout`; the desk
stages the opening frame to agree with it, and each shot of a result says whether its camera shows the planned layout
(`planAgrees`, null for a shot without one). Rideo attaches a shot that disagrees all the same (the person staged it)
and lists it in the result's summary: "S3: the camera does not show the planned layout".

## The desk

The Storyboard view (`/p/:id/storyboard`) shows **Director's desk** on every scene row (storyboarded and production
scenes) whose clip has shots, when the setting is on. It opens a full-screen panel inside the studio's root (so it
keeps the theme): a header with the scene's title and **Close**, a status line, and the iframe filling the rest. The
page behind it is inert while it is open. On phones it is the same panel, inside the safe-area insets.

**Which reference.** The desk decides which reference the shots get: its own **Follow** menu (*Motion*, *Poses*,
*Camera*) picks the mode, and its **Send** renders that mode only (and the stills). Rideo has no Follow menu of its own.
It opens the desk with all three modes (`modes`, in the protocol's order) and, preselected, the mode last attached in
this project (`defaultMode`; *Camera* when none), attaches the mode each clip of a result carries, names it in the
result's summary ("Attached 4 camera references.") and remembers it for the next open: the browser keeps it per project
([the result](#the-result)).

- **Connecting.** No `hello` within 15 seconds of a `load` event of the iframe that no `hello` has answered: "The
  desk at <origin> did not answer. Check that it is served with the headers it needs" with a link to
  [these headers](#topology-and-headers); **Close** still works. The desk posts `hello` from its own `load` handler,
  which usually reaches rideo before the iframe's `load` event, so the bridge counts both: a `load` with no `hello` for
  it (the first, or the desk page loading again, say into the browser's error page after the desk was redeployed
  without its headers) drops the old connection, shows "Connecting to the desk at …" again and starts the 15 seconds.
- **A stored state that cannot be loaded.** The bridge reads the stored state before `open`. Any answer but the state
  or `204` (none stored) (a `503` `storage_error`, a `404` for a clip that is gone, a network error) or a state whose
  `X-Desk-State-Format` and `X-Desk-State-Version` rideo does not know fails the panel: "The stored desk could not be loaded: <reason>" with **Retry**, which reads it again and
  opens the desk once it has it, and **Start over**. Until then the desk is not opened (a desk without the stored state
  would stage the brief or its own copy, and the next store would replace the stored state with it), and nothing is
  ever stored in that panel. Retry mends a storage that failed for a while; a file that is missing from storage or
  failed its hash check may be gone for good, and no Retry brings it back. **Start over**, after a confirmation, clears
  it (`DELETE …/desk-state`) and opens the desk again, which then opens its own copy of the scene in a browser that
  has one, else stages the brief. The confirmation says what is lost (whatever was staged only in the stored state),
  that the other browsers' copies of the scene are replaced by what is stored next, and so to start over in the
  browser that has the newest work: a browser without a copy stages the brief afresh, and once that is stored, every
  other browser drops its own copy for it the next time its desk opens.
- **A stored state that is kept.** When the desk answers the state rideo handed over with `state_unreadable` (a state
  written by a newer desk, say), or a write finds that the stored state is not the one it replaces
  ([when rideo stores it](#when-rideo-stores-it)), rideo never replaces the stored state on its own: the panel says so
  (and a toast, once per notice) and stores nothing in that panel, not on Close, on the way out or after 10 minutes.
  The notice is chosen by what happened:
  - the desk could not read it: "The stored desk state was kept." followed by the desk's own message as a sentence of
    its own (the real desk's: "The stored desk state was not applied (…); the scene was staged from the brief.") and
    "Changes made here are not stored until you replace it.";
  - a `412` that names a stored state (another session stored one, or restored an older one): "Another session
    changed the stored desk state of this clip, and it was kept: changes made here are not stored until you replace
    it. If it is another staging of the scene, the desk drops this browser's copy the next time it opens unless you
    replace it.";
  - a `412` without an `ETag` (another session cleared it): "Another session cleared the stored desk state of this
    clip: changes made here are not stored until you replace it."

  **Replace the stored desk state**, after a confirmation that says what it replaces (the state this desk could not
  read, the state another session stored, or nothing as another session cleared it) and that the project's history
  keeps that state, stores the desk's newest state over the kept one as a commit of its own (a desk that sent none yet
  is asked for the one it holds, `save`, and the first state that comes after Replace is stored at once, however long
  the desk takes), and later ones as usual.
- **Approved clips** open read-only: the person can look and render, and a result is refused for their shots
  ([the result](#the-result)).
- **Closing.** **Close** asks the desk for its state (`save`), stores it and closes (a desk that does not answer within
  5 seconds: the newest state it sent is stored); the desk's own **Done** sends the last state and `close`, and its
  **Close** sends `close`, preceded by a `state` when edits were not sent yet. Closing never waits for a result's
  uploads (they go on after the panel closed, and their toast still says what was attached) and waits at most
  10 seconds for the last state's write (the request is aborted after that, and the failure is said in a toast): the
  person is never held in the panel. A `412` found while closing is the one exception, whether the last write met it
  or a write that was already on its way when Close was pressed (the 10 minutes' write, the write before a result):
  the panel stays open with that notice, to **Replace the stored desk state** or Close again, which closes without
  storing. Keys pressed inside the iframe go to the desk: the panel closes with its button, never with Escape.
- **Leaving without Close.** When the panel goes away without **Close** (another view, the browser's or Android's
  back, the scene's clip leaving the Storyboard view), the newest state not stored yet is stored on the way out, best
  effort: the request is not waited for (nothing is stored when the stored state is kept; a write refused with a `412`
  is said in a toast, unless the state stored meanwhile is one the next panel of the same clip in this tab stored,
  [when rideo stores it](#when-rideo-stores-it)). The iframe is keyed by the clip, so a panel that gets another clip
  loads the desk again and connects afresh.

## The result

A `result` comes when the person presses **Send** in the desk (its `id` starts with `desk-`). Its schema bounds it: at
most 200 shots (the brief's maximum) and 800 files (four per shot), file names of at most 200 characters. Rideo takes
the shots in order, one at a time; a shot that fails does not stop the others. A shot the desk could not render is left
out of the result, and the desk names it in an `error` `export_failed` after the result, which rideo shows
([the protocol](#the-protocol)).

1. **Refused**, with the reason, checked in this order: the result is of another scene than the panel's ("the result
   is of another scene"); the shot is no longer in the clip ("the shot is no longer in the clip"); the shot is listed a
   second time in the result ("the shot is in the result twice": its first entry is the one taken); the clip is
   approved ("clip <n> is approved: unapprove it to change its shots"); the result's size, frame rate or the shot's
   frame count is not the clip's (`max(1, round(durationSec × fps))`): when the project's size or frame rate or the
   shot's duration changed in rideo since the brief the desk was opened with, "the shot changed since the desk
   rendered it: render it again"; when they did not, the desk rendered something else than the brief asked for. A
   shot the brief retimed since the desk staged it, sent without **Update shots**: "the clip has 60 frames and the
   shot 72 (3 s at 24 fps): the brief changed the shot's length since the desk staged it; press Update shots in the
   desk, then send again". A shot whose length the person changed in the desk: "the clip has 84 frames and the shot
   72 (3 s at 24 fps): set its length back in the desk, or change the shot's duration in the studio". The desk tells
   the two apart at Send, from its changes then, in the shot's `brief_length` issue (whose code alone does not tell
   them apart): it points to Update shots for the first and says to set the length back for the second, a length
   changed after Update shots brought the shot to the brief included. A shot with that issue is refused as its issue
   says; only a shot without one is told apart by `opened`'s `changes.retimed`, the brief's changes when the desk
   opened, which no later message updates. Another size or frame rate: "the clip is 1280×720 at 25 fps, the scene
   1280×720 at 24 fps". Then: the shot has no clip in the result ("the result has no clip for the shot"), names a file
   the result does not carry as `video/mp4` ("the file <name> is not in the result"), or one that is not an MP4 file,
   whose bytes 4–7 are not `ftyp` ("the file <name> is not an MP4 clip").
2. **The reference.** The clip of the mode the shot carries (`references`): a **Send** renders one mode, the desk's
   Follow, and each of its shots carries that one. A shot that carries several (an `export` that asked for several)
   gets the mode last attached in this project when it has it, else the first of `motion`, `pose`, `camera` (the
   protocol's order) it has. The clip becomes `desk-c<clip>-s<shot>-<mode>.mp4` (`video/mp4`) and goes
   through the same upload as every browser file (`POST /api/projects/:id/uploads`, role `reference`), with a probe
   made from the result (`hasVideo`, no audio, `videoCodec` `h264`, the result's width, height and fps, `durationSec`
   = frames / fps), so the resource is ready at once, and with the shot's still as its poster (re-encoded as JPEG in
   the browser: posters are stored as JPEG). A still without the PNG signature, or whose `IHDR` is not the result's
   width × height, is dropped (the clip goes without a poster), so the browser never decodes an image of a size the
   result did not announce.
3. **The shot.** `PATCH /api/projects/:id/clips/:clipId/shots/:shotId` with
   `{motionReference: {resourceId, mode}, camera: {lensMm, move}}`: the reference to follow, and the lens and move
   the desk staged (`move` null when the staged camera has no named move). A `camera` in a PATCH changes only the
   fields it names: the shot keeps its planned `framing` and `movement` (and its aperture).

Then rideo answers `result-ack` (`ok` when every shot was attached, a one-line `message`, and `shots` with each
shot's `ok` and `error`), which the desk shows, and shows the same summary as a toast. The summary names the mode
attached: "Attached 4 camera references.", "Attached 3 of 4 camera references." (then each refused shot with its
reason), "Attached 4 references: 3 camera, 1 motion." when shots got different modes, "Attached 0 of 4 references."
when none was attached. The mode attached (of several, the one attached to the most shots, the first in the protocol's
order on a tie) is remembered by the browser for the project: the desk opens on it next time (`defaultMode`). The
files' bytes are let go once uploaded. A shot's earlier references stay as resources; only the shot's
`motionReference` changes.

## What the image and video models get

Nothing new reaches a prompt. A shot attached from the desk has a motion reference and a camera like any other
([directing](directing.md)): the video request carries the clip as `reference_video` with its mode's phrase
(`Reproduce the camera movement of the reference video.` for *Camera*), the camera line and `camera_motion` follow the
lens and the move, and a shot with a motion reference gets a video request of its own ([multi-shot](multi-shot.md)).
Motion, pose and camera references go to the model as they were uploaded, without a transcode: the clip already has
the project's frame rate and size and exactly the shot's frames. A changed lens or move changes the keyframe prompt's
camera line, so the shot's storyboard frame is *outdated* and drawn again ([storyboard](storyboard.md)); a new motion
reference leaves the frame current (it is part of the video prompt only).

## The desk state

The desk's state is opaque bytes (`format` `3d-editor.desk-state`, `version` 1, at most 64 MiB) that rideo stores per
clip and gives back on the next `open`. Rideo never reads them.

**Where.** The bytes are an immutable media file named by its hash, `media/desk/<scene-slug>-<hash12>.bin`
(`application/octet-stream`), and the clip names it:

```ts
clip.deskState: {
  format: string;    // as the desk gave it: '3d-editor.desk-state'
  version: number;   // 1
  media: MediaRef;   // path, hash (sha256), size
  updatedAt: string;
} | null             // null: none stored
```

That is how rideo keeps every file: documents are versioned and media is immutable and referenced by hash
([version control](version-control.md)), so a clip restored to an earlier commit, or read on another branch, gets the
desk state it had then, and the file travels with the project on WebDAV, in the browser's storage and in project
files. A file rewritten in place would not survive a restore or a branch. Rideo keeps every media file until the
project is deleted, so it stores states sparingly.

### When rideo stores it

The desk sends `state` after its edits (at most every 5 seconds). The bridge keeps the newest and stores it when the
panel closes (after `save`, or on the desk's `close`; at most 10 seconds, [closing](#the-desk)), when the panel goes
away without closing (best effort), before it applies a `result`, and while the desk stays open at most once every
10 minutes (counted from the last write, or from the panel's opening; any write, the one before a result too, starts
the 10 minutes again) when the state changed since: every write of a changed state is a new media file that rideo
keeps until the project is deleted, up to 64 MiB each.

Before `open` the bridge reads the stored state and its sha256 (the `ETag`). A state whose bytes equal the stored one
is not stored again (the desk sends the same bytes for an unchanged scene), and the server changes nothing for the
state it already holds (no new file, no commit): opening the desk and closing it without an edit stores nothing. A
stored state the bridge cannot load (any answer but the state or `204`, a network error, format or version headers it
does not know) fails the panel with **Retry** and **Start over** ([the desk](#the-desk)): the desk is not opened, and nothing is
stored in that panel, so a state staged without the stored one never replaces it. Between two writes the desk's own
copy holds the work on that device. Each write is a commit, `Save the desk of scene <n>`, coalesced per clip and author
like typing ([coalescing](version-control.md#coalescing)), but for a Replace (below), which is a commit of its own; a
`DELETE` is a commit `Clear the desk of scene <n>`.

Rideo never replaces a stored state the person has not chosen to replace. Every write names the state it replaces:
`If-Match` with the `ETag` of the state the panel last loaded or stored, or `If-None-Match: *` when none was stored.
When the stored state is another one (another browser or device stored one meanwhile, or restored an older one), or
none (another session cleared it), the server answers `412` `desk_state_conflict` with the stored state's `ETag` (none
when it was cleared), and the stored state is kept: the panel says so ([the notices](#the-desk)) and stores nothing
more on its own. Until the person replaces it, the changes made in that panel live only in this browser's copy of the
scene; when the stored state is another staging (a scene staged on two devices before either stored, say), the desk
drops that copy for the stored state the next time it opens, which the notice says. When the desk answers the state
rideo handed over with `state_unreadable`, the stored state is kept the same way, with the desk's message: no write on
Close, on the way out or after 10 minutes in that panel. A write refused with a `412` is not tried again; one on the
way out of the panel is said in a toast.

**A 412 of this tab's own.** A write can meet a state this tab sent itself: an earlier write whose answer was lost (the
network dropped it, or a proxy gave up while the server finished the write), a write on the way out of a panel that
landed after the next panel of the same clip loaded the stored state, or a Close's write that outlived its 10 seconds.
That is no conflict. The tab remembers, per clip and for as long as the page lives (beyond a panel), the sha256 of the
states it sent, until it sees the server is past one: a state whose write was refused for another stored state is
forgotten at once (that write never lands); one whose write was stored, once the answer to a request this tab sent after
that (a load of the stored state, a write, a Start over's clear) names another stored state; one whose write was never
answered (lost or aborted), once the answer to a request this tab sent after it names a state other than the one that
write replaces, the only one it can still land over. On a `412` whose `ETag` is one it remembers, sent by this panel or
by an earlier panel of the clip, the write takes that `ETag` as the stored state's and is tried once more at once (a
later panel's desk opened from this browser's copy of the scene, which holds the earlier panel's work, so its state
follows that one). A state the tab sent that comes back once forgotten is another session's doing (a restore of the
project or of the clip, or the same bytes stored elsewhere): a conflict like any other, with its notice. Only a restore
to a state whose write the tab never saw answered, while every answer since named the state that write replaces, cannot
be told from that write landing late, and is taken the same way. A write on the way out of a panel that meets a state a
later panel of this tab stored is dropped without a notice: the later state is the newer one.

**A Replace.** **Replace the stored desk state**, after its confirmation, stores the desk's newest state over the
kept one (a desk that sent none yet, as after `state_unreadable`, is asked for the one it holds with `save`: rideo
waits for the answer however long the desk takes, and the first state that comes after Replace is stored at once), with
`If-Match` naming the state the notice was about, or `If-None-Match: *` after a clear (so a state a third session
stored in between is refused again, not replaced unseen), and with `X-Desk-State-Replace: 1`: that write is a commit of
its own and never amends the tip, even when the tip is the replaced state's own commit by the same author within the
coalescing window, so the project's history keeps the state it replaces, as the confirmation says. Later states are
stored as usual; they coalesce with each other, never into the Replace's commit (it carries no coalescing key).

A write that fails is said in the status line ("The desk could not be stored: <reason>; trying again in 30 s") and in
one toast, and is tried again with a backoff: 30 seconds after the first failure, then 1, 2, 4, 8 and 10 minutes
(doubling, at most 10), whatever states arrive meanwhile, never once per state. The next success says "Desk stored",
ends the backoff, and a later failure toasts again.

### The routes

| Route | Body | Returns |
|---|---|---|
| `GET /api/projects/:id/clips/:clipId/desk-state` | – | the bytes (`application/octet-stream`) with `X-Desk-State-Format`, `X-Desk-State-Version`, `ETag` (the sha256); `204` No Content when the clip names no state (no body, no `ETag`, `Cache-Control: no-store`: the usual answer of a first open, which a browser does not log as an error; rideo reads its empty body to the end, as every answer, or Chromium would report the read as cancelled); `404` `not_found` only for a project or a clip that is not there; `503` `storage_error` when it names one whose file cannot be read (storage answered `404` for it, failed, or its bytes failed the hash check). A storage that failed may answer later, but a file that is missing or failed its hash check may be gone for good, which no retry mends: `DELETE` the state (the panel's **Start over**), and the next `open` uses the desk's own copy of the scene or the brief |
| `PUT /api/projects/:id/clips/:clipId/desk-state` | the bytes (`application/octet-stream`, at most 64 MiB) with `X-Desk-State-Format` and `X-Desk-State-Version`, and the state it replaces: `If-Match` with its `ETag`, or `If-None-Match: *` for none; `X-Desk-State-Replace: 1` when the person chose to replace that state (the panel's [Replace](#when-rideo-stores-it)) | `{deskState}` (`200`, with the new state's `ETag`; the same when the bytes were stored already, whatever the precondition); `412` `desk_state_conflict` when the stored state is not the one named (the answer's `ETag` is the stored state's, none when the clip names none; nothing is stored: the precondition is checked before the bytes are kept as a file, and again in the commit, which finds a state stored while the body was arriving). A `PUT` without a precondition replaces whatever is stored (scripts; the studio always sends one). Each write is a commit coalesced per clip and author; one with `X-Desk-State-Replace: 1` is a commit of its own, which never amends the tip, so the history keeps the state it replaces |
| `DELETE /api/projects/:id/clips/:clipId/desk-state` | – | `204`: the clip names no state (the file stays, as all media). The next `open` sends none: the desk restores its own copy of the scene in a browser that has one (and the next state rideo stores writes it back), else stages the brief |

The body of a `PUT` is never parsed or held in memory, whatever its type: the route reads every body as a stream (it
has no JSON or text parser), a declared `Content-Length` over 64 MiB is refused before the body is read, and a body
without one (chunked) is counted as it is written to a temporary file and refused once it passes 64 MiB. Any other body
type is refused with `422` without being read (the rest of the body is let through unread). A request whose client goes
away, even before the service looks at its body, ends at once: its temporary file is removed and its file closed. The
state is stored in every storage mode (the embedded WebDAV, an external server, the browser's storage).

A state is stored for any clip, approved or not (it is the desk's working copy, not the film), and a clip planned
again keeps it: the desk lists the shots the new plan added and removed when it opens.

## Library units

The episodes of a season share their 3D sets, props and figures through the studio [library](library.md): the desk
saves a set, a prop or an actor's figure as a **unit** (a file of its own, `3d-editor.desk-unit` version 1), rideo
keeps it in the library and **pins** a version of it on the entity that uses it (a location's set, a prop, a
character's figure), and every scene that stages that entity gets the unit when its desk opens. It is an additive,
negotiated extension of protocol version 1, owned like the rest by the 3D-Editor
([library units](https://github.com/sloth-os/3D-Editor/blob/main/docs/embedding.md#library-units)). Rideo mirrors its
schemas in `packages/shared/src/schemas/desk.ts`, inside the closed unions (so `post()` still validates every message
rideo sends), with message ids of `DeskRequestIdSchema`, and keeps a verbatim copy of its fixtures in
`packages/shared/test/fixtures/desk-protocol/`: valid `ready-units.json`, `open-units.json`,
`open-units-figure-hints.json`, `unit-publish-set.json`, `unit-publish-figure-new-version.json`,
`unit-ack-linked.json`, `unit-ack-unlinked.json`, `unit-ack-refused.json` and `state-units.json`; invalid
`open-units-bad-pin.json`, `unit-publish-two-from.json`, `unit-publish-bad-sha.json`,
`unit-publish-thumbnail-too-large.json`, `unit-ack-ok-without-ref.json` and `state-units-bad-staged.json`; and
`units/unit-file-prop.json`, a unit file the 3D-Editor's core wrote (a red kite), which the server's and the browser's
readers of the unit file ([3D units](library.md#what-it-holds)) read as a prop and which an upload keeps as a desk-prop.

A unit version is `{ref, version, sha256}` everywhere: `ref` is the library item's id (`lib_…`), `version` its
integer version (1, 2, …) and `sha256` the hash of the unit file's bytes
([the three hashes](library.md#the-three-hashes)).

### Negotiation

| Field | What rideo does |
|---|---|
| `ready.capabilities.units` `{versions, kinds, maxBytes, publish}` | reads it leniently: kinds it does not know are dropped; a capability that is malformed, or lists no version 1 or no kind left, reads as "no units", and `ready` is never refused for it |
| `open.options.units` `{version: 1, publish}` | sent only to a desk that announced units; `publish` is whether the person may publish to the library (`libraryAllows(…, 'publish')`): without it the desk offers no Save to library |

Without both, nothing of this section is exchanged:

| Desk | Studio | What happens |
|---|---|---|
| from before units (no capability) | this one | no `options.units`, no pins in the brief, no `open.units`: the messages of before, byte for byte |
| with units | from before units (no `options.units`) | the desk sends no `unit-publish` and no `state.units`, and shows no Library tab |
| with units | this one | everything below |

### Pins in the brief

`deskBrief(docs, clipId, {units: {kinds}})` adds the pins when the open has units, for the kinds the desk announced
(`set`, `prop`, `figure`); without `units` the brief is what it was, byte for byte. A pin is `{ref, version, sha256}`,
taken from the entity's `deskUnit` ([pins](library.md#pins-on-entities)):

| Brief | From | Rule |
|---|---|---|
| `set.unit` | the `deskUnit` of the scene's location (`scene.locationId`), a `desk-set` | the scene's place is its set: a location row of `elements[]` never carries a unit (a desk ignores one, with a warning) |
| `elements[].unit` | a prop element's `deskUnit`, a `desk-prop` | props only |
| `cast[].unit` | the character's `deskUnit`, a `desk-figure` | |
| `cast[].kind`, `cast[].heightM` | that figure pin's `actorKind` and `heightM` | members with a figure pin only (the others as in [the brief](#the-brief)); `heightM` only within 0.1–4 m, else null. A stand-in staged before the unit arrives then already has the figure's rig, and the unit changes its look, not its build |

The brief agents read (`desk-brief`, `desk_brief`) carries no pins: the 3D-Editor's `desk_stage_brief` has no way to
get the units' bytes in P0.

### Unit bytes in `open`

The desk never asks for a unit: rideo knows which units a brief names and pushes them in `open.units` (transferred,
like the state), once it has loaded the stored state and before it posts `open`:

- **Which**: every pin of the brief, in slot order (the set, the cast, the elements), once per `ref@version`, except a
  pin whose slot needs no file: the slot's row of `clip.deskState.units` is staged `unit` and names the same `ref` and
  `version` (the desk's record already has that pin), or is staged `unit` with `local`, whatever its `ref` and
  `version` (the person made the slot local, and the desk never places a unit there again, so a version or another item
  pinned since takes no file, nor any of the 48 MiB below). When the stored state's units are not known, every pin
  goes.
- **From where**: `GET /api/library/items/:itemId/versions/:version/files/:sha256`, at most 2 at a time. The route is
  immutable, so the browser's HTTP cache serves a unit the next time.
- **Checked**: the bytes' sha256 (WebCrypto) must be the pin's; a file that does not match is left out.
- **Bounded**: at most 48 MiB in all: the first unit that would pass it, and every one after it, is left out.
- **Never held up**: a fetch that fails (offline, an answer other than `200`, an item this studio does not have) or
  receives nothing for 30 seconds is left out. Meanwhile the status line says "Getting the scene's library units (2 of
  3)…", and **Close** works throughout.

A unit left out is no error: the desk stages its slot from the brief's words and records the pin `pending`
(`missing`), and the next open sends it again ([when a unit does not arrive](#when-a-unit-does-not-arrive)). The desk
keeps the units it got only while the scene is open, for its **Update shots**.

### Publishing and linking

The desk's **Save to library…** sends `unit-publish`, only when `options.units.publish` was true: its `kind` (`set`,
`prop`, `figure`), `name`, `description`, `newVersionOf` (`{ref, version}`, the version it was made from; none for a
new item), `from` (the brief slot it came from: `{set: true}`, `{castId}` or `{elementId}`), the unit file and its
`sha256` (transferred), a PNG `thumbnail` (at most 64 KiB, or null) and `meta`. The bridge takes one publish at a
time, in the order they come:

1. **Checks** the bytes' sha256 against `sha256`: a mismatch is refused (`invalid`) and nothing is uploaded.
2. **Publishes** through the library ([uploads](library.md#surfaces)): a new item (`POST /api/library/items`) named
   `name`, with `description`, or, with `newVersionOf`, a new version of that item with `basedOn` =
   `newVersionOf.version` (`POST /api/library/items/:itemId/versions`): the item keeps its name (the message's `name`
   names only the file), and `description`, trimmed and cut to the 500 characters of a version note, is the new
   version's note (none when it is empty). The kind `set`, `prop` or `figure` is the item kind `desk-set`,
   `desk-prop` or `desk-figure`, and the digest the server computed must be the message's `sha256` again. Bytes equal
   to the item's current version publish nothing new and answer that version.
3. **Links**, by the contract's rule: only when (a) the open is not read-only, (b) the person may edit the project,
   and (c) the entity `from` names has no pin, or pins the same item (a new version moves its pin; a publish never
   re-points an entity that uses another item). The entity is the scene's location for `{set: true}`, the character for
   `{castId}`, the prop element for `{elementId}`. The link is an apply in mode `pin` with `replacePin: false`
   (`POST /api/projects/:id/library/apply`), one commit; its `409` `{reason: "pinned"}` (someone pinned another item
   meanwhile) is (c) again.
4. **Answers** `unit-ack` with the message's `id`: `{ok: true, ref, version, linked, message?}`, where `linked: false`
   carries the reason: "the scene is read-only", "you may not edit this project", "Harbor uses another library set
   (Old harbor)", "the scene has no place". The desk adopts the published objects as an instance of that version, and
   writes the pin into its record, only when `linked` is true.

A refusal is `{ok: false, code, message}`, by what the library answered:

| The library answered | `code` |
|---|---|
| `412` `library_conflict`: another version came after `newVersionOf` (the message names the latest) | `conflict` |
| `413` | `too_large` |
| `422` (`validation_error`, `consent_required`), a sha256 that does not match, or a `unit-publish` that does not validate | `invalid` |
| `403` | `refused` |
| `503`, or the studio is offline | `unavailable` |
| anything else | `failed` |

A `unit-publish` on an open without units (no desk should send one) is answered `{ok: false, code: "refused"}` at once,
so the desk never waits out its timeout of 120 s plus 10 s per MiB of the unit. One that does not validate (a newer
desk's unit format, a kind or `meta` this studio does not read) is answered at once too, `{ok: false, code: "invalid"}`
with the message "this studio cannot read the publish: …" naming the checks that failed, after the `error` `bad_message`
that every invalid message with an `id` gets (the desk does not read it); nothing is uploaded. The panel says what
happened, in its status line and a toast: "Saved Harbor v3 to the library; linked to the scene's place (Harbor)", "Saved
Harbor v1 to the library; not linked: Harbor uses another library set (Old harbor)", "Not saved to the library: …". An
approved, read-only clip may publish; it is never linked.

### What a stored state uses

After an open with units, every `state` carries `units`: one row per brief slot whose record has a pin, each slot once,
sorted by slot in plain string order (`cast:<characterId>`, `el:<elementId>`, `set`), at most 128, each `{slot, ref,
version, sha256, staged: 'unit' | 'pending' | 'refused', local, why?}`. Rideo reads it leniently: rows that do not
validate, rows that name a slot twice (no header below could carry them) or more than 128 rows read as "unknown", and
the state is stored all the same; rows in another order are read as they come.

The bridge keeps each state's rows with its bytes and sends them with its write, as a header of the existing streamed
`PUT …/desk-state` (rideo still never reads the state's bytes):

```
X-Desk-State-Units: cast:chr_0j8kc3v9m2a7mr5t=lib_0j8kc4n2q1h7mira@2:unit:local, el:ele_0j8kc3x0b5k9dn2p=lib_0j8kc4n2q1h7lamp@1:pending:missing, set=lib_0j8kc4n2q1h7wz3x@3:unit
```

- A row is `<slot>=<ref>@<version>:<staged>[:local][:<why>]`, rows are joined by `, `, and `-` is none. No header
  means unknown; rows that would not fit (more than 128, over 8 KiB, a slot named twice) are left out of the write,
  which goes on with the units unknown.
- The server keeps them on the clip, beside the state they describe; `DELETE …/desk-state` clears them with it:

  ```ts
  clip.deskState: {
    format: string; version: number; media: MediaRef; updatedAt: string;
    units?: { slot: string; ref: string; version: number; staged: 'unit' | 'pending' | 'refused';
              local: boolean; why?: string }[] | null;   // absent or null: not known
  } | null
  ```

- A header that does not parse is refused with `422` (counted `refused`, logged with the reason `units`). The same
  bytes again change nothing, the stored rows included. The embedding origins' CORS allows `x-desk-state-units`.

### Drift: the Storyboard badge

`deskUnitDrift(docs, clipId)` (shared, pure) compares the pins of the clip's brief with what its stored state uses,
slot by slot:

| Status | When | Badge |
|---|---|---|
| `current` | the state's row has the pin's item and version, staged `unit` | – |
| `update` | the row names another version or another item, or the slot has no row (the pin came after the state); a slot made local is `local` instead | "3D: v3 available" |
| `pending` | the row is the pin's, staged `pending` | "3D: waiting" |
| `refused` | the row is the pin's, staged `refused` | "3D: can't use Harbor v3" |
| `local` | the person made that slot local in the desk (its row is staged `unit` with `local`), whatever its pin is now: the desk never puts a unit back in a slot made local, so a pin moved since then is no update for this clip; the tooltip names what it was made local from and what is pinned now | – |
| `unknown` | the stored state's units are not known (a state from before units, or written without the header) | – |
| `approved` | the clip is approved and its state does not use the pinned version | "approved: keeps v2" |

A clip without a stored state has no rows: its first open stages with the pins. The badge names the first slot that
needs attention, in the order can't use, waiting, available, approved, and its tooltip lists every pinned slot with
its status and reason. Opening the desk on a scene with `update` rows brings the new pins and their units, and the
desk's banner offers **Update shots**.

### When a unit does not arrive

| The desk's reason | Its record | `state.units` | Drift | What to do |
|---|---|---|---|---|
| placed | `unit` | `unit` | `current` | – |
| `missing`: rideo did not send it (offline, the fetch failed, past the 48 MiB of an open, an item this studio does not have) | `pending` | `pending:missing` | `pending` | open the scene again once online; past 48 MiB, use fewer or smaller units |
| `mismatch`: the bytes are not the pin's | `pending` | `pending:mismatch` | `pending` | open the scene again |
| `unavailable`: the desk could not use it this time | `pending` | `pending:unavailable` | `pending` | open the scene again |
| `unreadable`, `too_new` (a newer desk's), `too_large` (over 32 MiB) | `refused` | `refused:<why>` | `refused` | pin another version |
| `wrong_kind` (not the slot's kind), `set_ground` (the set's ground is not at height 0) | `refused` | `refused:<why>` | `refused` | pin another unit, or save one that fits from the desk |
| `figure_kind` (the figure is not of the staged actor's kind, or of a kind the desk does not build), `figure_rig` (the figure does not fit the staged actor's rig or height, ±5 mm) | `refused` | `refused:<why>` | `refused` | pin a figure of the staged actor's kind and height (the desk keeps the actor) |
| `over_budget`: the unit is larger than one desk staging takes (the scene's units together past the budget wait `unavailable` instead) | `refused` | `refused:over_budget` | `refused` | pin a smaller unit |
| made local in the desk (it stays so, whatever the slot's pin becomes) | `unit` | `unit:local` | `local` | – |
| a desk from before units, or no header | – | – | `unknown` | – |

`pending` pins are tried again at every open, `refused` ones only when the pin changes, so a unit that can never be
placed does not bring the banner back at every open.

### Old desks and old studios

- A desk from before units never sees a unit field ([negotiation](#negotiation)).
- A state whose document holds unit instances is written as container version 2. A desk from before units (one cached
  offline, say) answers `state_unreadable` for it, and rideo keeps the stored state
  ([a stored state that is kept](#the-desk)).
- A studio from before units never sends `options.units`, and a desk with units works for it as before.

## Agents

`GET /api/projects/:id/clips/:clipId/desk-brief` and the MCP tool `desk_brief` (`projectId`, `clipId`, read-only)
return the clip's brief. An agent stages it with the 3D-Editor's MCP tool `desk_stage_brief`, renders the shots there,
and attaches each clip with rideo's own tools: `resource_add` (the clip as an https or `data:` URI; a video added that
way is probed by an open studio tab, `media.process`) and `shot_update` with `motionReference` and `camera` (the
camera fields it names, `{lensMm, move}`: the shot's framing and movement stay as planned). The desk state has no MCP
tool: it is the browser desk's opaque bytes, up to 64 MiB, and agents work from the brief. Agents pin library units on
entities and move those pins with the library's tools (`library_apply`, `library_detach`, `library_status`,
[the library](library.md#surfaces)); the brief they read carries no pins ([pins in the brief](#pins-in-the-brief)).

## Surfaces

| REST | MCP |
|---|---|
| `GET /api/projects/:id/clips/:clipId/desk-brief` → the `SceneBrief` | `desk_brief` |
| `GET` / `PUT` / `DELETE /api/projects/:id/clips/:clipId/desk-state` (`PUT` with `X-Desk-State-Units`, [what a stored state uses](#what-a-stored-state-uses)) | – (opaque bytes, [above](#agents)) |
| `GET /api/library/items/:itemId/versions/:version/files/:sha256`: the units of `open` | – (bytes) |
| `POST /api/library/items`, `POST /api/library/items/:itemId/versions`: a `unit-publish` | – (bytes) |
| `POST /api/projects/:id/library/apply` (mode `pin`): the link after a publish, the 3D row | `library_apply` |
| `POST /api/projects/:id/library/detach` (`deskUnit`): unpin | `library_detach` |

REST and MCP call the same `DeskService` (`packages/server/src/domain/desk.ts`); the library's routes and tools call
`LibraryService` ([the library](library.md#surfaces)). The desk's URL reaches browsers in `GET /api/config`
(`features.desk`).

| Error | When |
|---|---|
| `not_found` (404) | the project, the clip (any id, `constructor` and `__proto__` too: clips are looked up as the project's own); a clip that names no desk state is not one (its `GET` answers `204`) |
| `storage_error` (503) | the clip names a desk state whose file cannot be read: retry later, or `DELETE` the state when its file is gone for good |
| `desk_state_conflict` (412) | a `PUT` whose `If-Match` or `If-None-Match` does not name the stored state (another session stored one, restored an older one or cleared it): the answer's `ETag` is the stored state's, and its `detail` says so without calling either state newer ("the stored desk state of scene <n> is not the one this write replaces: another session changed it (the stored state's ETag is "<sha256>")", or "scene <n> has no stored desk state any more: another session cleared it") |
| `validation_error` (422) | a brief of a clip without shots ("plan the shots of clip <n> first"); a state without its format and version headers, of another format or version than the desk's, or not `application/octet-stream` (any other body type, malformed or empty JSON too: it is never parsed); an `X-Desk-State-Units` header that does not parse, or names more than 128 rows or 8 KiB |
| `validation_error` (413) | an `application/octet-stream` state over 64 MiB: by its `Content-Length`, before the body is read, or counted as it arrives |

The desk's own errors (`unsupported_version`, `invalid_scene`, `busy`, `export_unavailable`, `export_failed`,
`out_of_memory`, `cancelled`, `not_open`, `state_unreadable`) are shown with their message in the panel's status line,
those meant for the person as a toast too ([the protocol](#the-protocol)); rideo's server records none of them.

## What happened to the blocking

On November 14, 2026 rideo's own desk was removed: the `clip.blocking` document (`SceneBlocking`) and its solver, line
and checks, `settings.blocking`, the `scene.block` job and LLM task, the blocking line and moves in the keyframe,
video, scene-sheet and multi-shot prompts, the camera view and its phrase in keyframe requests, the storyboard
reviewer's blocking lines, camera views and `blocking` dimension, the `/blocking` REST routes, the `blocking_*` MCP
tools, the `rideo_blocking_*` metrics, the job notice, the mock gateway's floor plans and the SVG desk.

- **Stored documents still read.** A project's `settings.blocking` is dropped when the project is read; a clip's
  `blocking` is ignored by everything that reads the clip and is gone after the clip's next write (every write
  validates its document). Stored reviews whose issues or recommendations name the `blocking` dimension still parse
  (a legacy dimension no reviewer is asked for; the panel lists them under its name and draws no bar for an old
  `scores.blocking`). Job records of `scene.block` no longer parse and leave the job list.
- **Prompts.** A project that never turned the desk on (every project since October 30, and the schema's default)
  keeps byte-identical prompts and current frames. A project that had `settings.blocking.enabled`: its blocked shots'
  frames are *outdated* once (their prompt hash held the blocking), and the storyboard draws them again; the lens and
  move the old desk wrote to its shots stay. A production scene whose storyboard review passed before the upgrade is
  drawn again too: the production batch approves a reviewed scene's frames only when none of them needs drawing
  (`missing`, `failed`, `stale` or `outdated`), else it storyboards the scene again ([production
  storyboards](ai-review.md#production-storyboards)), which draws only those frames and reviews it once more.
- **The 3D-Editor's old bridge** (server to server, through the `/blocking` routes) is gone from the 3D-Editor too; the
  [protocol](#the-protocol) replaces it.

## Observability

`rideo_desk_state_saves_total{outcome}` counts the states sent to the server (`saved`: a new state stored;
`unchanged`: the stored one again; `conflict`: refused with `412`, the stored state not the one the `PUT` named;
`refused`: too large, another format or version, without its headers, or not `application/octet-stream`, whatever the
body: every body reaches the service, so no refusal is answered by the HTTP framework uncounted) and
`rideo_desk_briefs_total` the briefs served (REST and MCP). The server logs `desk state saved` with the project, the
clip, the size, the sha256, the format, the version, the file's path and whether it was a Replace (`replace`, a commit
of its own); `desk state refused` with the project, the clip and the reason (`content-type`, `headers`, `format` or
`size`); `desk state conflict` with the project, the clip, the `If-Match` and `If-None-Match` sent and the stored
state's sha256; and `desk state unreadable` (warn) with the project, the clip, the file's path and the error, when the
clip names a state whose file cannot be read (the `503`).
With library units, `desk state saved` also carries `units` (how many rows the state's `X-Desk-State-Units` named, or
`unknown`), and `desk state refused` has the reason `units` for a header that does not parse (counted `refused`). A
publish is counted and logged by the library (`rideo_library_total{event}` `created`, `version` or `unchanged`, then
`pinned` for its link; `library item created`, `library version added`, `library applied`:
[the library](library.md#observability)).
The studio logs the messages it ignored or refused, the desk's errors, the states it could not store or load, a
`412` that named a state of its own (taken as the stored one, or newer from a later panel), each unit it left out of
an `open` and why, and each publish's answer, to the browser's console (`[desk] …`, at the debug level).

## Tests

- **Unit (shared):** the brief from rideo's documents (`desk-brief.test.ts`), row by row of [the table](#the-brief):
  names, odd sizes rounded down, interiors from `INT.`, `EXT.`, `I/E` and other headings, the time of day from the
  scene or the heading, heights in centimetres, millimetres, metres and feet (a comma as the thousands separator, a
  space only before a metric length, decimal commas, "1 m 70" and "1 metre 70", inches only below 12 after feet, feet
  and inches followed by a weight: "5 ft 11 180 lbs", "5'11 180 lbs", "5 ft 7 120 lbs", "about 5 ft 9 160 lbs",
  "4 ft 10 100 lbs", "6 ft 1 200 lbs", and "1 m 70 120 lbs"), the cast and element order, the limits and cut strings,
  ids filtered to the brief's cast and layouts to the shot's own cast (a character taken out of a shot but still in
  another), a clip without shots and clip ids such as `constructor`; the protocol's schemas (`desk-protocol.test.ts`)
  against a verbatim copy of the 3D-Editor's fixtures, `{"$bytes": …}` decoded to ArrayBuffers: every valid one parses
  (in its direction too) and each invalid one is refused but `state-units-bad-staged.json` (its state parses, with its
  units unknown), a state over 64 MiB, a result over its limits (201 shots,
  801 files, a 201-character file name), the same 20 moves and framings as rideo's, the desk page's URL rule; a
  result's plan (`desk-result.test.ts`): the mode each shot carries, of several the one last attached, else the first
  in the protocol's order, every refusal (a shot listed twice, a clip that is not MP4 among them, a frame count or
  format the desk changed told apart from a shot or project changed in rideo since the brief, a shot the brief retimed
  since it was staged, by a `brief_length` issue that points to Update shots or, for a shot without one, by
  `changes.retimed`, told apart from a length the person changed in the desk, whose `brief_length` issue says to set it
  back even when `changes.retimed` still lists the shot: Update shots brought it to the brief, then the person changed
  its length), a still dropped without its PNG signature or of another size, an odd resolution, the summary naming the
  modes attached and the mode to remember, and the shot's PATCH parsed by the update schema to only the lens and the
  move; the update schema's camera (`shot-update.test.ts`): a partial camera keeps to the fields it names, the others
  are not filled in with defaults, an unknown framing is refused; legacy documents with `blocking` fields and reviews
  with the `blocking` dimension. `RIDEO_DESK_URL` in the server's configuration (`config.test.ts`): a desk on the
  studio's own host name refused with accounts on, allowed without them and on another host.
- **Unit (server):** the production batch (`batch-boards.test.ts`) storyboards a scene whose review passed but whose
  approved frames are outdated, and generates its video once they are drawn again; frames that are current but not
  approved are only approved again. A desk state write's precondition (`desk-precondition.test.ts`) evaluated as
  RFC 9110 does: `If-Match` by strong comparison (a weak tag never matches), with a list and `*`, then `If-None-Match`;
  the conflict's message, which names the stored state's `ETag` (or the clear) and never calls a state newer.
- **Integration** (`packages/server/test/integration/desk.test.ts`): `desk-brief` and `desk_brief` returning the same
  brief, a clip without shots refused, the metric; the desk-state routes: the bytes back as stored with their headers
  and `ETag`, a media file under `media/desk/`, a second PUT of the same bytes changing nothing, `DELETE`; a commit per
  state, coalesced per clip and author, and a clip restored with its state; a Replace (`X-Desk-State-Replace: 1`) right
  after another session's write by the same author a commit of its own, the history keeping the state it replaced (the
  history names its file, and a restore brings it back), the next write not amending it; `204` (no body, no `ETag`,
  not cached) for a clip that names no state, on the built-in WebDAV server and in a browser's storage, `404` for a
  project or clip that is not there, `503` `storage_error` for one whose file is gone, which a `DELETE` clears; a `PUT`'s precondition:
  `If-None-Match: *` storing a first state and refused with `412` `desk_state_conflict` and the stored `ETag` once one
  is stored (the answer's `detail` naming it), `If-Match` with the `ETag` a `PUT` answers storing the next and a stale
  one refused (no `ETag` once the state is cleared, and a `detail` that says so), the same bytes accepted whatever the
  precondition, a `PUT` without one replacing whatever is stored, each conflict counted and logged, and no media file
  kept for a `PUT` refused before its bytes are kept; the precondition checked again in the commit once the body has
  arrived (a state stored while a slow body was arriving is kept, the slow `PUT` answered `412`); the refusals (413 by
  `Content-Length` and for a chunked body past 64 MiB, 422 without the headers, for another format or version and every
  other body type: valid, malformed and empty JSON, text, and a JSON body declaring 70 MiB, none of them parsed) with
  the `refused` count and the `desk state refused` log; a request whose client goes away before the service reads its
  body leaves no temporary file and no open file; clip ids such as `constructor`, `__proto__` and `toString` answered
  `404` on every desk route and in `desk_brief`; a partial camera through `PATCH` and `shot_update` keeping the shot's
  framing and movement; the state kept in the browser's storage on the studio that keeps projects in browsers; the
  setting saved and reaching `GET /api/config` (`features.desk`), an `http:` page that is not on `localhost` refused.
  The embedding origins (`embedding.test.ts`): a preflight from an origin of `RIDEO_CORS_ORIGINS` allows the desk
  state's headers (`x-desk-state-format`, `x-desk-state-version`, `x-desk-state-replace`, `if-match`, `if-none-match`).
- **Unit (web):** the bridge with fake windows and ports (`desk-bridge.test.ts`): a `hello` only from the iframe's
  window and the desk's origin, the version mismatch (cut to 300 characters), the 15-second timeout after a `load` no
  `hello` answered (Close still works), a `hello` that arrives before the `load` event, a desk page that loads again
  (connecting again, then the timeout), `open` after `ready` with the brief, a copy of the stored state and the options,
  a second `hello` before the desk's first state (the stored state again) and after it (the newest state), a stored
  state that cannot be loaded (an error, a network failure, unknown headers): the panel failed with Retry, nothing
  opened or stored, Retry opening the desk, Start over clearing the stored state and opening the desk without it, a desk
  page that has not said hello keeping its 15 seconds; states of another scene ignored, the newest state stored at most
  every 10 minutes while the desk is open and only when its bytes are not the stored ones (with the real sha256 against
  the `ETag` that `api.deskState` reads), every write naming the state it replaces (`If-Match` with the loaded or stored
  `ETag`, the loaded bytes' sha256 without one, `If-None-Match: *` when none is stored), a write before a result
  starting the 10 minutes again, a state that comes while a write is stored waiting 10 minutes from that write, a
  failing write tried again after 30 seconds, then 1, 2, 4, 8 and 10 minutes with one toast until it succeeds, Close
  storing the answer to `save` (or, after 5 seconds without one, the newest state) without waiting for a result's
  uploads and at most 10 seconds for the write, the desk's own `close` (after a state, or alone), the newest state
  stored when the panel goes away without Close; a stored state kept: after `state_unreadable` for the state handed over
  (and the old desk's state sent at once after it) nothing stored on Close, on the way out or after 10 minutes until
  Replace, which stores the newest state (a desk that sent none asked for it with `save`, its answer stored at once
  even after 5 seconds and more) and later ones as usual, the notice with the desk's message as a sentence of its own,
  and one toast however often a desk page that loads again says `state_unreadable`; after a `412` no write tried
  again, the notice chosen by the stored `ETag` (another state, or cleared), a Close held open with the notice whether
  its own last write or a write already on its way met the `412`, Close again closing without a write, Replace naming
  the `ETag` the conflict gave (`If-None-Match: *` after a clear) and marked as a Replace, a third session's state
  refused again, a conflict on the way out said in a toast; a `412` naming a state this tab sent: the lost answer
  (the next write taking that `ETag` and stored without a notice), the panel that opened again while the last one's
  write on the way out was uploading (its write meeting that state, taken and stored, also when that write went out
  after the new panel's load, which named the older state it replaces; or, when the new panel's write landed first, the
  old panel's write dropped without a toast), tried once; a state this tab stored that another session restored after
  the tab saw the server move past it (its own later write, a `412`, a later panel's load or a Start over's clear found
  another state; Replace meeting such a restore refused again), a state whose write was never answered restored after an
  answer named another state than the one that write replaces (Replace refused again), and a state whose write was
  refused, its bytes stored by another session after Replace or before it, kept as a conflict with its notice and toast;
  `bad_message` for an invalid message with an `id`, unknown types ignored, the state stored before a result and
  `result-ack` with the summary's toast, a result applied with the brief and the shots the brief retimed (`opened`'s
  `changes.retimed`) of its connection, export unavailable, progress, the desk's errors as toasts only when meant for
  the person (`not_open` for Close's `save` in the status line only), and a disposed bridge that reports no status; the
  panel (`desk-panel.test.tsx`): no Follow menu of its own, `open`'s options (the three modes in the protocol's order,
  the mode last attached in this project, *camera* in another), its store, load and clear on the desk-state routes with
  the precondition and the Replace header (a `204` loaded as none stored, its empty body read to the end as the
  clear's is, `api.test.ts`, a `404` as the failure it is), the close timeout's `AbortSignal` reaching `fetch`, a `412`
  made a conflict
  with the stored `ETag`, a result applied with the brief and the retimed shots it was given (a length changed in the
  desk and one the brief retimed each refused with its own reason, the shot's own `brief_length` issue over a stale
  retimed list) and its mode remembered, the bridge flushed and disposed when the panel goes away, the iframe mounted
  anew for another clip, Replace (its three confirmations) and Start over only after their confirmations; a result
  applied (`desk-results.test.ts`): each clip uploaded with its probe and JPEG poster and its shot patched, an approved
  clip refused without an upload, a failing shot not stopping the others, the buffers let go; the Settings page's desk
  URL and its help (`settings.test.tsx`).
- **End to end (desktop and mobile):** a fake desk (`e2e/fixtures/desk/`, served by `e2e/support/desk-page.ts` on its
  own origin, `localhost` against the studio's `127.0.0.1`, with `Cross-Origin-Embedder-Policy: require-corp`,
  `Cross-Origin-Resource-Policy: cross-origin` and `Content-Security-Policy: frame-ancestors` naming the studio)
  speaks protocol version 1: it shows the brief's shots and the state it was given, sends the same bytes again for an
  unchanged scene, has a Follow menu of its own (preselected from `defaultMode`), and its **Send** posts a result for
  every shot of the brief in that mode only, as the real desk's does (`max(1, round(durationSec × fps))` frames, a
  checked-in 24-frame 320×180 H.264 clip and a PNG still of the brief's size drawn by the page, the last shot
  disagreeing with the plan); its **Send part** leaves the last shot out and names it in an `error` `export_failed`
  after the result, its **Send longer** renders the first shot half a second longer with a `brief_length` issue that
  says to set its length back, a stored state that starts with `unreadable` is one it cannot read (`error`
  `state_unreadable`, then `opened` from the brief, and no state until an edit), and one that starts with `retimed` was
  staged before the brief retimed the first shot, as the real desk tells it: `opened` lists that shot in
  `changes.retimed`, the desk's own **Update shots** brings it to the brief, and until then **Send longer**'s issue on
  it points to Update shots.
  `e2e/director-desk.spec.ts` opens the desk on a scene whose clip has no stored state (the read answered `204`, no
  console error, and the browser reports the read finished, not cancelled; the page behind it inert, no Follow menu in
  the panel, the desk opened on *Camera*, the iframe sandboxed without top navigation), sends the result and finds
  through the API every
  shot's motion reference and staged lens and move with its planned framing and movement kept, and each uploaded clip
  ready with its probe and JPEG poster, the summary naming the mode, the plan's disagreement in the toast; the state
  stored on Close and given back on the next open, opened and closed again without an edit storing nothing (the same
  file, no commit), the desk's own **Done** storing its last state; an edit stored when the person leaves the Storyboard
  view with the browser's back instead of Close; a state another session stored while the desk was open kept at Close
  (the panel stays with the notice, Close again closes), and so is a state this tab stored that another session put back
  after storing another one (a restore: the tab saw the server move past it); a partial result attaching the shots it
  has and the desk's `export_failed` in a toast; a stored state the desk cannot read kept (the notice and a toast, an
  edit not stored on Close) until **Replace the stored desk state** after its confirmation; a stored state the server
  cannot read (`503`): the panel failed with **Retry**, the desk not opened, **Retry** opening it, and **Start over**
  after its confirmation clearing the state (its `DELETE` finished, not cancelled) and opening the desk from the
  brief; *Poses* chosen in the desk's own Follow
  menu attached and remembered for the project after a reload (the desk opened on *Poses*), and a shot sent longer than
  its brief refused with "set its length back in the desk" (the brief reaching the result's plan); a desk opened on a
  state staged before the brief retimed the first shot: sent longer, that shot refused with "press Update shots in the
  desk", and after the desk's Update shots with "set its length back in the desk" though `opened` listed it; a desk page
  served without its headers answered by the timeout message after 15 seconds, **Close** still closing; an approved clip
  opened read-only and its result refused; nothing scrolls sideways. With the scene's location pinned to a library set
  through the API, the v1 fake desk still gets no unit field: no `options.units`, no pin in the brief, no `open.units`.
- **Library units, unit (shared and web):** the protocol's schemas against the new fixtures (`desk-protocol.test.ts`:
  every valid one parses, each invalid one is refused but `state-units-bad-staged.json`, whose state parses with its
  units unknown) and the capability read leniently (only version 2, garbage, only unknown kinds: no units, and `ready`
  still parses), `state.units` too (rows that do not validate, 129 rows, a slot named twice: units not known, and the
  state still parses); the brief (`desk-brief.test.ts`) without units the same byte for byte even when entities are
  pinned, and with units `set.unit` from the scene's location only, prop pins, figure pins with the figure's kind and
  height (null outside 0.1–4 m), kinds the desk did not announce left out, no unit on a location row;
  `X-Desk-State-Units` formatted and parsed (`-`, no header, `local`, a reason; 129 rows, over 8 KiB and bad syntax
  refused, rows naming a slot twice no header) and the docs' example in the desk's row order, `deskUnitDrift` for every
  status (a slot made local staying `local` whatever its pin becomes), the badge's order and the desk's refusals in
  words (`over_budget`, `figure_kind`, `figure_rig`), and `deskUnitPinsToSend` leaving out a slot made local whatever
  its pin (`desk-units.test.ts`); the bridge (`desk-bridge.test.ts`): a desk
  without the capability gets no `options.units`, no pins and no `open.units`; a desk with units gets `options.units`
  with `publish`, then `open.units` in slot order, fetched 2 at a time, once per version, without the pins the stored
  state uses, a file that does not match or does not arrive left out, 48 MiB never passed (a slot made local taking no
  share of it), the buffers transferred; `unit-publish` saving a new item, a new version with `basedOn` and the
  description as its note (cut to 500 characters, none when empty) and the same bytes again, linked by the rule's cases
  (read-only, no permission to edit, another pin, a `409` on the link: each `linked: false` with its reason), every
  refusal mapped to its code, publishes one at a time, a publish on an open without units refused at once, one that does
  not validate answered `bad_message` and `unit-ack` `invalid` at once with its notice; each state's units sent with its
  write, and none when they do not fit or name a slot twice (the state stored with its units unknown).
- **Library units, integration** (`desk.test.ts`): `X-Desk-State-Units` kept on the clip with its state (`-` as none,
  no header as unknown), a header that does not parse refused with `422` and counted, the same bytes again keeping the
  rows, `DELETE` clearing them; the embedding origins' preflight allows `x-desk-state-units` (`embedding.test.ts`).
- **Library units, end to end** (`e2e/desk-units.spec.ts`, desktop and mobile, on the stack's units studio, whose
  `RIDEO_DESK_URL` is the fake desk's `desk.html?units=1`): the fake desk in units mode announces the capability,
  shows its brief's pins and the units it got (version and bytes checked), keeps a record per pinned slot inside its
  state's bytes, sends `state.units` and has **Publish set**, **Publish new version** and **Publish prop**; in either
  mode it lists every unit field an `open` carried. A scene whose place, cast member and prop are pinned opens with
  their pins in slot order and their bytes; Close records the state's units on the clip (no badge), and the next open
  sends no file for the pins that state uses; **Publish set** on an unpinned place creates an item, links the place in
  one commit and is acked `linked`; **Publish new version** makes v2 and moves the pin; another scene at that place
  shows "3D: v2 available" until its desk opens again with v2's bytes, the Library page's **Used in** saying
  "Stored desk states: 1 clip uses v2" before and "2 clips use v2" after; an approved clip's desk may publish, and the
  publish is acked not linked ("the scene is read-only"); no sideways scroll.
