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
| Never | sends the desk a URL, a token or media; reads the state's bytes | calls rideo's server, sends anything rideo did not give it |

The desk is optional. Without [`RIDEO_DESK_URL`](#the-setting) there is no desk, and nothing else changes. It is a
person's tool in the browser; agents work from the same brief with the 3D-Editor's own MCP tools
([agents](#agents)).

## The setting

`RIDEO_DESK_URL` (Settings → **Limits and embedding**, group `jobs`, a URL field): the desk page, for example
`https://desk.example.com/desk.html`. Empty (the default): no desk, and the **Director's desk** buttons are not shown.
The URL must be `https:`, or `http:` on `localhost` or `127.0.0.1` for development (both pages must be
[secure contexts](#topology-and-headers)); its path is the page itself, not a folder. Like every setting, the
environment wins and locks the field ([settings](settings.md)).

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
| `open` {`scene`: the [brief](#the-brief), `state`, `options`} | after `ready` and once the stored state was loaded ([a state that cannot be loaded](#when-rideo-stores-it) opens nothing), once per connection: a desk page that loads again says `hello` again, is connected again and gets the newest state the panel holds (the desk's newest `state`, else the stored state: `open` transfers a copy of its bytes and the panel keeps the original). `options` = `hostName` (the studio's brand name, `RIDEO_BRAND_NAME`, at most 40 characters), `modes` `["camera", "motion", "pose"]`, `defaultMode` (the person's mode, [the desk](#the-desk)), `readOnly` for an approved clip |
| `save` | when the person closes the panel: the desk answers `state` with the same `id` (rideo waits at most 5 seconds, then stores the newest state the desk sent); also when the person replaces a [kept](#when-rideo-stores-it) state and the desk sent none yet |
| `export` | never on its own: the person presses **Send** in the desk |
| `result-ack` | after each `result`: what was attached and what was refused, shot by shot |

| The desk sends | Rideo |
|---|---|
| `ready` | sends `open`; when `capabilities.export.available` is false, says why under the panel's title ("This browser cannot render the reference clips: …"): staging still works |
| `opened` | shows the desk ("Opened from the stored desk", "… from this browser's copy", "… from the brief"); the desk itself lists the brief's changes and offers to update its shots |
| `state` | keeps the newest (a state of another scene is ignored), and stores it ([when](#when-rideo-stores-it)) |
| `progress` | shows the export's phase and count under the title |
| `result` | applies it ([the result](#the-result)) and answers `result-ack` |
| `error` | shows its message under the title; the errors meant for the person (`state_unreadable`, `export_failed`, `export_unavailable`, `out_of_memory`, `invalid_scene`) as a toast too, while the desk's answers to rideo's own requests (`not_open` for a `save` that came while the desk was still staging, `bad_message`, `unsupported_version`, `busy`, `cancelled`) go to the status line and the browser's console only. `state_unreadable` (the desk could not read the state rideo handed over) keeps the stored state: the panel says so with the desk's reason and stores nothing on its own ([a stored state that is kept](#the-desk)); `export_failed` after a `result` names the shots the desk left out of it |
| `close` | stores the last state (unless the stored one [is kept](#when-rideo-stores-it)) and closes the panel |

Rideo speaks version 1. A desk that offers no version rideo speaks is not connected: "This desk speaks protocol
versions …; this studio speaks 1". Every message is validated with zod in both directions (`packages/shared`, the
schemas of the protocol and of the brief); a message of a type rideo does not know is ignored and logged, one that
does not validate is ignored and logged too, and one that carried an `id` is answered with `error` `bad_message`. Text
the desk supplies (its versions, the reason export is unavailable, its errors' messages, the names of a result's
files) is cut to 300 characters wherever rideo shows it, in the status line and in toasts.
Rideo keeps a copy of the 3D-Editor's fixtures (one valid example of every message and some invalid ones) in
`packages/shared/test/fixtures/desk-protocol/`, and its tests parse every valid one and reject every invalid one, so a
change on either side that breaks the other shows up in the tests.

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
| `cast[].heightM` | `identity.height` | a measure it names ("170 cm", "1700 mm", "1,700 mm", "1 700 mm", "1.2 m", "1,70 m", "1 m 70", "1 metre 70", "1m70", "5 ft 7 in", "5 ft 7", `5'7"`; a number after feet counts as inches only below 12, so "6 ft 180 lbs" is 1.83 m; a comma or a space before three digits is a thousands separator, and where that reading gives no height in range the comma is a decimal comma, "1,750 m", and the space parts two numbers, "a girl of 8 120 cm" is 1.2 m), to the centimetre, 0.1–4 m; else null |
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
keeps the theme): a header with the scene's title, the person's **Follow** mode (*Camera*, *Motion*, *Poses*: the
reference the shots get; the browser remembers it, *Camera* by default) and **Close**, a status line, and the iframe
filling the rest. The page behind it is inert while it is open. On phones it is the same panel, inside the safe-area
insets.

- **Connecting.** No `hello` within 15 seconds of a `load` event of the iframe that no `hello` has answered: "The
  desk at <origin> did not answer. Check that it is served with the headers it needs" with a link to
  [these headers](#topology-and-headers); **Close** still works. The desk posts `hello` from its own `load` handler,
  which usually reaches rideo before the iframe's `load` event, so the bridge counts both: a `load` with no `hello` for
  it (the first, or the desk page loading again, say into the browser's error page after the desk was redeployed
  without its headers) drops the old connection, shows "Connecting to the desk at …" again and starts the 15 seconds.
- **A stored state that cannot be loaded.** The bridge reads the stored state before `open`. Any answer but `404` (a
  `503` `storage_error`, a network error) or a state whose `X-Desk-State-Format` and `X-Desk-State-Version` rideo does
  not know fails the panel: "The stored desk could not be loaded: <reason>" with **Retry**, which reads it again and
  opens the desk once it has it, and **Start over**. Until then the desk is not opened (a desk without the stored state
  would stage the brief or its own copy, and the next store would replace the stored state with it), and nothing is
  ever stored in that panel. Retry mends a storage that failed for a while; a file that is missing from storage or
  failed its hash check may be gone for good, and no Retry brings it back. **Start over**, after a confirmation that
  says what is lost (whatever was staged only in the stored state), clears it (`DELETE …/desk-state`) and opens the
  desk again, which then opens its own copy of the scene in a browser that has one, else stages the brief.
- **A stored state that is kept.** When the desk answers the state rideo handed over with `state_unreadable` (a state
  written by a newer desk, say), or a write finds that another session stored a newer state
  ([when rideo stores it](#when-rideo-stores-it)), rideo never replaces the stored state on its own: the panel says so
  ("The stored desk state was kept: the desk could not read it (<reason>)", "Another session stored a newer desk
  state for this clip; it was kept", a toast too) and stores nothing in that panel, not on Close, on the way out or
  after 10 minutes. **Replace the stored desk state**, after a confirmation, stores the desk's newest state over the
  kept one (a desk that sent none yet is asked for the one it holds, `save`), and later ones as usual.
- **Approved clips** open read-only: the person can look and render, and a result is refused for their shots
  ([the result](#the-result)).
- **Closing.** **Close** asks the desk for its state (`save`), stores it and closes (a desk that does not answer within
  5 seconds: the newest state it sent is stored); the desk's own **Done** sends the last state and `close`, and its
  **Close** sends `close`, preceded by a `state` when edits were not sent yet. Closing never waits for a result's
  uploads (they go on after the panel closed, and their toast still says what was attached) and waits at most
  10 seconds for the last state's write (the request is aborted after that, and the failure is said in a toast): the
  person is never held in the panel. A last write refused because another session stored a newer state is the one
  exception: the panel stays open with that notice, to **Replace the stored desk state** or Close again, which closes
  without storing. Keys pressed inside the iframe go to the desk: the panel closes with its button, never with Escape.
- **Leaving without Close.** When the panel goes away without **Close** (another view, the browser's or Android's
  back, the scene's clip leaving the Storyboard view), the newest state not stored yet is stored on the way out, best
  effort: the request is not waited for (nothing is stored when the stored state is kept; a write refused because
  another session stored a newer state is said in a toast). The iframe is keyed by the clip, so a panel that gets
  another clip loads the desk again and connects afresh.

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
   rendered it: render it again"; when they did not, the desk rendered something else than the brief asked for: a
   shot whose length the person changed in the desk, "the clip has 84 frames and the shot 72 (3 s at 24 fps): set its
   length back in the desk, or change the shot's duration in the studio", or another size or frame rate, "the clip is
   1280×720 at 25 fps, the scene 1280×720 at 24 fps"; the shot has no clip in the result ("the result has no clip for
   the shot"), names a
   file the result does not carry as `video/mp4` ("the file <name> is not in the result"), or one that is not an MP4
   file, whose bytes 4–7 are not `ftyp` ("the file <name> is not an MP4 clip").
2. **The reference.** The file of the person's mode (`references[mode]`; when the result has none for that mode, the
   first of `camera`, `motion`, `pose` it has) becomes `desk-c<clip>-s<shot>-<mode>.mp4` (`video/mp4`) and goes
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
shot's `ok` and `error`), which the desk shows, and shows the same summary as a toast. The files' bytes are let go once
uploaded. A shot's earlier references stay as resources; only the shot's `motionReference` changes.

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
stored state the bridge cannot load (any answer but `404`, a network error, format or version headers it does not
know) fails the panel with **Retry** and **Start over** ([the desk](#the-desk)): the desk is not opened, and nothing is
stored in that panel, so a state staged without the stored one never replaces it. Between two writes the desk's own
copy holds the work on that device. Each write is a commit, `Save the desk of scene <n>`, coalesced per clip and author
like typing ([coalescing](version-control.md#coalescing)); a `DELETE` is a commit `Clear the desk of scene <n>`.

Rideo never replaces a stored state the person has not chosen to replace. Every write names the state it replaces:
`If-Match` with the `ETag` of the state the panel last loaded or stored, or `If-None-Match: *` when none was stored.
When another session stored a newer state meanwhile (another browser or device), or cleared it, the server answers
`412` `desk_state_conflict` with the stored state's `ETag`, and the stored state is kept: the panel says "Another
session stored a newer desk state for this clip; it was kept" and stores nothing more on its own. When the desk answers
the state rideo handed over with `state_unreadable`, the stored state is kept the same way, with the desk's reason
("The stored desk state was kept: the desk could not read it (…)"): no write on Close, on the way out or after
10 minutes in that panel. In both cases **Replace the stored desk state**, after a confirmation, stores the desk's
newest state over the kept one (a desk that sent none yet, as after `state_unreadable`, is asked for the one it holds
with `save`), with `If-Match` naming the state the notice was about (so a state a third session stored in between is
refused again, not replaced unseen), and later states are stored as usual. A write refused that way
is not tried again; one on the way out of the panel is said in a toast.

A write that fails is said in the status line ("The desk could not be stored: <reason>; trying again in 30 s") and in
one toast, and is tried again with a backoff: 30 seconds after the first failure, then 1, 2, 4, 8 and 10 minutes
(doubling, at most 10), whatever states arrive meanwhile, never once per state. The next success says "Desk stored",
ends the backoff, and a later failure toasts again.

### The routes

| Route | Body | Returns |
|---|---|---|
| `GET /api/projects/:id/clips/:clipId/desk-state` | – | the bytes (`application/octet-stream`) with `X-Desk-State-Format`, `X-Desk-State-Version`, `ETag` (the sha256); `404` `not_found` only when the clip names no state; `503` `storage_error` when it names one whose file cannot be read (storage answered `404` for it, failed, or its bytes failed the hash check). A storage that failed may answer later, but a file that is missing or failed its hash check may be gone for good, which no retry mends: `DELETE` the state (the panel's **Start over**), and the next `open` uses the desk's own copy of the scene or the brief |
| `PUT /api/projects/:id/clips/:clipId/desk-state` | the bytes (`application/octet-stream`, at most 64 MiB) with `X-Desk-State-Format` and `X-Desk-State-Version`, and the state it replaces: `If-Match` with its `ETag`, or `If-None-Match: *` for none | `{deskState}` (`200`, with the new state's `ETag`; the same when the bytes were stored already, whatever the precondition); `412` `desk_state_conflict` when the stored state is not the one named (the answer's `ETag` is the stored state's, none when the clip names none). A `PUT` without a precondition replaces whatever is stored (scripts; the studio always sends one) |
| `DELETE /api/projects/:id/clips/:clipId/desk-state` | – | `204`: the clip names no state (the file stays, as all media). The next `open` sends none: the desk restores its own copy of the scene in a browser that has one (and the next state rideo stores writes it back), else stages the brief |

The body of a `PUT` is never parsed or held in memory, whatever its type: the route reads every body as a stream (it
has no JSON or text parser), a declared `Content-Length` over 64 MiB is refused before the body is read, and a body
without one (chunked) is counted as it is written to a temporary file and refused once it passes 64 MiB. Any other body
type is refused with `422` without being read (the rest of the body is let through unread). A request whose client goes
away, even before the service looks at its body, ends at once: its temporary file is removed and its file closed. The
state is stored in every storage mode (the embedded WebDAV, an external server, the browser's storage).

A state is stored for any clip, approved or not (it is the desk's working copy, not the film), and a clip planned
again keeps it: the desk lists the shots the new plan added and removed when it opens.

## Agents

`GET /api/projects/:id/clips/:clipId/desk-brief` and the MCP tool `desk_brief` (`projectId`, `clipId`, read-only)
return the clip's brief. An agent stages it with the 3D-Editor's MCP tool `desk_stage_brief`, renders the shots there,
and attaches each clip with rideo's own tools: `resource_add` (the clip as an https or `data:` URI; a video added that
way is probed by an open studio tab, `media.process`) and `shot_update` with `motionReference` and `camera` (the
camera fields it names, `{lensMm, move}`: the shot's framing and movement stay as planned). The desk state has no MCP
tool: it is the browser desk's opaque bytes, up to 64 MiB, and agents work from the brief.

## Surfaces

| REST | MCP |
|---|---|
| `GET /api/projects/:id/clips/:clipId/desk-brief` → the `SceneBrief` | `desk_brief` |
| `GET` / `PUT` / `DELETE /api/projects/:id/clips/:clipId/desk-state` | – (opaque bytes, [above](#agents)) |

REST and MCP call the same `DeskService` (`packages/server/src/domain/desk.ts`). The desk's URL reaches browsers in
`GET /api/config` (`features.desk`).

| Error | When |
|---|---|
| `not_found` (404) | the project, the clip (any id, `constructor` and `__proto__` too: clips are looked up as the project's own), or a desk state to read when the clip names none |
| `storage_error` (503) | the clip names a desk state whose file cannot be read: retry later, or `DELETE` the state when its file is gone for good |
| `desk_state_conflict` (412) | a `PUT` whose `If-Match` or `If-None-Match` does not name the stored state (another session stored or cleared one): the answer's `ETag` is the stored state's |
| `validation_error` (422) | a brief of a clip without shots ("plan the shots of clip <n> first"); a state without its format and version headers, of another format or version than the desk's, or not `application/octet-stream` (any other body type, malformed or empty JSON too: it is never parsed) |
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
clip, the size, the sha256, the format, the version and the file's path; `desk state refused` with the project, the
clip and the reason (`content-type`, `headers`, `format` or `size`); `desk state conflict` with the project, the clip,
the `If-Match` and `If-None-Match` sent and the stored state's sha256; and `desk state unreadable` (warn) with the
project, the clip, the file's path and the error, when the clip names a state whose file cannot be read (the `503`).
The studio logs the messages it ignored or refused, the desk's errors, and the states it could not store or load, to
the browser's console (`[desk] …`, at the debug level).

## Tests

- **Unit (shared):** the brief from rideo's documents (`desk-brief.test.ts`), row by row of [the table](#the-brief):
  names, odd sizes rounded down, interiors from `INT.`, `EXT.`, `I/E` and other headings, the time of day from the
  scene or the heading, heights in centimetres, millimetres, metres and feet (a comma or a space as the thousands
  separator, decimal commas, "1 m 70" and "1 metre 70", inches only below 12 after feet), the cast and element order,
  the limits and cut strings, ids filtered to the brief's cast and layouts to the shot's own cast (a character taken
  out of a shot but still in another), a clip without shots and clip ids such as `constructor`; the protocol's schemas
  (`desk-protocol.test.ts`) against a verbatim copy of the 3D-Editor's fixtures, `{"$bytes": …}` decoded to
  ArrayBuffers: every valid one parses (in its direction too) and every invalid one is refused, a state over 64 MiB, a
  result over its limits (201 shots, 801 files, a 201-character file name), the same 20 moves and framings as rideo's,
  the desk page's URL rule; a result's plan (`desk-result.test.ts`): the file of the person's mode or the fallback,
  every refusal (a shot listed twice, a clip that is not MP4 among them, a frame count or format the desk changed told
  apart from a shot or project changed in rideo since the brief), a still dropped without its PNG signature or of
  another size, an odd resolution, the summary, and the shot's PATCH parsed by the update schema to only the lens and
  the move; the update schema's camera (`shot-update.test.ts`): a partial camera keeps to the fields it names, the
  others are not filled in with defaults, an unknown framing is refused; legacy documents with `blocking` fields and
  reviews with the `blocking` dimension. `RIDEO_DESK_URL` in the server's configuration (`config.test.ts`): a desk on
  the studio's own host name refused with accounts on, allowed without them and on another host.
- **Unit (server):** the production batch (`batch-boards.test.ts`) storyboards a scene whose review passed but whose
  approved frames are outdated, and generates its video once they are drawn again; frames that are current but not
  approved are only approved again.
- **Integration** (`packages/server/test/integration/desk.test.ts`): `desk-brief` and `desk_brief` returning the same
  brief, a clip without shots refused, the metric; the desk-state routes: the bytes back as stored with their headers
  and `ETag`, a media file under `media/desk/`, a second PUT of the same bytes changing nothing, `DELETE`; a commit per
  state, coalesced per clip and author, and a clip restored with its state; `404` only for a clip that names no state,
  `503` `storage_error` for one whose file is gone, which a `DELETE` clears; a `PUT`'s precondition: `If-None-Match: *`
  storing a first state and refused with `412` `desk_state_conflict` and the stored `ETag` once one is stored,
  `If-Match` with the `ETag` a `PUT` answers storing the next and a stale one refused (no `ETag` once the state is
  cleared), the same bytes accepted whatever the precondition, a `PUT` without one replacing whatever is stored, each
  conflict counted and logged; the refusals (413 by `Content-Length` and for a chunked body past 64 MiB, 422 without the
  headers, for another format or version and every other body type: valid, malformed and empty JSON, text, and a JSON
  body declaring 70 MiB, none of them parsed) with the `refused` count and the `desk state refused` log; a request whose
  client goes away before the service reads its body leaves no temporary file and no open file; clip ids such as
  `constructor`, `__proto__` and `toString` answered `404` on every desk route and in `desk_brief`; a partial camera
  through `PATCH` and `shot_update` keeping the shot's framing and movement; the state kept in the browser's storage on
  the studio that keeps projects in browsers; the setting saved and reaching `GET /api/config` (`features.desk`), an
  `http:` page that is not on `localhost` refused.
- **Unit (web):** the bridge with fake windows and ports (`desk-bridge.test.ts`): a `hello` only from the iframe's
  window and the desk's origin, the version mismatch (cut to 300 characters), the 15-second timeout after a `load` no
  `hello` answered (Close still works), a `hello` that arrives before the `load` event, a desk page that loads again
  (connecting again, then the timeout), `open` after `ready` with the brief, a copy of the stored state and the options,
  a second `hello` before the desk's first state (the stored state again) and after it (the newest state), a stored
  state that cannot be loaded (an error, a network failure, unknown headers): the panel failed with Retry, nothing
  opened or stored, Retry opening the desk, Start over clearing the stored state and opening the desk without it, a
  desk page that has not said hello keeping its 15 seconds; states of another scene ignored, the newest state stored at
  most every 10 minutes while the desk is open and only when its bytes are not the stored ones (with the real sha256
  against the `ETag` that `api.deskState` reads), every write naming the state it replaces (`If-Match` with the loaded
  or stored `ETag`, the loaded bytes' sha256 without one, `If-None-Match: *` when none is stored), a write before a
  result starting the 10 minutes again, a state that comes while a write is stored waiting 10 minutes from that write,
  a failing write tried again after 30 seconds, then 1, 2, 4, 8 and 10 minutes with one toast until it succeeds, Close
  storing the answer to `save` (or, after 5 seconds without one, the newest state) without waiting for a result's
  uploads and at most 10 seconds for the write, the desk's own `close` (after a state, or alone), the newest state
  stored when the panel goes away without Close; a stored state kept: after `state_unreadable` for the state handed over
  (and the old desk's state sent at once after it) nothing stored on Close, on the way out or after 10 minutes until
  Replace, which stores the newest state (a desk that sent none asked for it with `save`) and later ones as usual;
  after a `412` no write tried again, a Close held open
  with the notice and Close again closing without a write, Replace naming the `ETag` the conflict gave and a third
  session's state refused again, a conflict on the way out said in a toast; `bad_message` for an invalid message with an
  `id`, unknown types ignored, the state stored before a result and `result-ack` with the summary's toast, export
  unavailable, progress, the desk's errors as toasts only when meant for the person (`not_open` for Close's `save` in
  the status line only), and a disposed bridge that reports no status; the panel (`desk-panel.test.tsx`): its store,
  load and clear on the desk-state routes with the precondition, the close timeout's `AbortSignal` reaching `fetch`, a
  `412` made a conflict with the stored `ETag`, the bridge flushed and disposed when the panel goes away, the iframe
  mounted anew for another clip, Replace and Start over only after their confirmations; a result applied (`desk-results.test.ts`): each clip uploaded with its probe and JPEG
  poster and its shot patched, an approved clip refused without an upload, a failing shot not stopping the others, the
  buffers let go; the Settings page's desk URL and its help (`settings.test.tsx`).
- **End to end (desktop and mobile):** a fake desk (`e2e/fixtures/desk/`, served by `e2e/support/desk-page.ts` on its
  own origin, `localhost` against the studio's `127.0.0.1`, with `Cross-Origin-Embedder-Policy: require-corp`,
  `Cross-Origin-Resource-Policy: cross-origin` and `Content-Security-Policy: frame-ancestors` naming the studio)
  speaks protocol version 1: it shows the brief's shots and the state it was given, sends the same bytes again for an
  unchanged scene, and its **Send** posts a result for every shot of the brief (`max(1, round(durationSec × fps))`
  frames, a checked-in 24-frame 320×180 H.264 clip per mode and a PNG still of the brief's size drawn by the page, the
  last shot disagreeing with the plan); its **Send part** leaves the last shot out and names it in an `error`
  `export_failed` after the result, and a stored state that starts with `unreadable` is one it cannot read (`error`
  `state_unreadable`, then `opened` from the brief, and no state until an edit).
  `e2e/director-desk.spec.ts` opens the desk on a scene (the page behind it inert, *Camera* by default, the iframe
  sandboxed without top navigation), sends the result and finds through the API every shot's motion reference and
  staged lens and move with its planned framing and movement kept, and each uploaded clip ready with its probe and JPEG
  poster, the plan's disagreement in the toast; the state stored on Close and given back on the next open, opened and
  closed again without an edit storing nothing (the same file, no commit), the desk's own **Done** storing its last
  state; an edit stored when the person leaves the Storyboard view with the browser's back instead of Close; a state
  another session stored while the desk was open kept at Close (the panel stays with the notice, Close again closes);
  a partial result attaching the shots it has and the desk's `export_failed` in a toast; a stored state the desk cannot
  read kept (the notice and a toast, an edit not stored on Close) until **Replace the stored desk state** after its
  confirmation; a stored state the server cannot read (`503`): the panel failed with **Retry**, the desk not opened,
  **Retry** opening it, and **Start over** after its confirmation clearing the state and opening the desk from the
  brief; *Poses* followed and remembered after a reload; a desk page served without its headers answered by the timeout
  message after 15 seconds, **Close** still closing; an approved clip opened read-only and its result refused; nothing
  scrolls sideways.
