# The studio library

A season is many projects: every episode is a project of its own, and they share a cast, the places it lives in, the
props it carries and the 3D sets the director's desk stages them on. The **studio library** keeps what episodes share,
once, in versions (v1, v2, …): characters, places and props (elements), resources, and the 3D sets, props and figures
of the [director's desk](director-desk.md). A project **uses** a version: characters, elements and resources are copied
into it with their ids and seeds, and 3D units are **pinned** by version on the entities that use them, their bytes
staying in the library until a scene's desk opens. Nothing moves by itself: a new version reaches a project when
someone there says so. (The studio as a library that other apps mount is another thing: [embedding](embedding.md).)

## Why

The request, as it was asked:

> "the 3D scene/modeling can be used cross rideo projects, cross rideo scenes, e.g. one season, multiple
> episodes(multiple projects) will use the similar 3D scene/modeling. Other resources may be in a similar situation"

A project is self-contained: its characters, elements and resources, and the desk states of its clips, live in its
folder. A second episode started from nothing: the writer invented the cast again ("Mia" for Mira, "the old docks"
for the Harbor), new references drew another face, new seeds made other pictures, and every scene's set was staged from
the words again. Importing the first episode as a copy shares its ids, but drags the whole episode along.

The library changes that:

- **One copy of each recurring thing**, studio-wide and versioned. A version never changes; a new one gets the next
  number.
- **Use in project copies** a character, element or resource into the project, keeping the library's `chr_` or `ele_`
  id, the seed and the wardrobe and reference ids: the identity lock, the prompts, the judge and the desk see the same
  person and the same place in every episode ([copy on apply](#copy-on-apply)).
- **3D units are pinned**, not copied: a location pins its set, a prop its prop, a character its figure. The desk gets
  the pinned unit when it opens a scene ([pins](#pins-on-entities)).
- **Pins and links move only when someone moves them**, one project at a time; each scene's desk shows the change at
  its next open, and approved clips keep what they have
  ([how a new version reaches the scenes](#how-a-new-version-reaches-the-scenes)).
- **The writer reuses names.** When a project already has characters or elements, `screenplay.generate` and
  `screenplay.extend` give the writer their names (characters: name, role and a one-line identity; elements: kind,
  name and aliases) with an instruction to use exactly those names for the people and places that match, so a new
  episode's scenes link to the library's Mira and Harbor instead of inventing new ones.

The second request, "rideo backend can directly request to 3D-Editor backend if it can improve efficiency", was
measured and answered: no server-to-server call in P0 ([server calls to the 3D-Editor](#server-calls-to-the-3d-editor)).

## What it holds

| Kind | An item is | Saved from | Used as |
|---|---|---|---|
| `character` | a character: name, role, summary, identity, wardrobe (with its ids), personality, its approved references with their consent records, its voice (description, provider and voice id, source, sample, consent, locked), seed, whether it was locked, and its 3D figure pin | **Save to library** on the character's card (`library_save`) | a character of the project: same id, seed, wardrobe and reference ids |
| `element` | a location, prop or style: kind, name, description, aliases, approved references, seed, whether it was locked, and its 3D set or prop pin | **Save to library** on the element's card | an element of the project, the same way |
| `resource` | an image, video, audio file or LUT with its kind, role, name and notes | **Save to library** on a resource row, or an upload | a new resource of the project (origin `library`) |
| `desk-set` | a 3D set: the place's geometry, dressing and landmarks, without cast, cameras, shots or sun | the desk's **Save to library…** (`unit-publish`), or an upload | the pin of a location element: every scene at that place is staged on it |
| `desk-prop` | a 3D prop: one object | the desk | the pin of a prop element |
| `desk-figure` | a 3D figure: an actor's look (parts, materials, attachments) on the desk's rig for its kind and height | the desk | the pin of a character: the figure the desk stages for them |

There is no `voice` kind: a voice travels inside its character, with its consent record. There are no series: items
carry free **tags** (`season 1`, `harbor town`) that the pickers filter by; series and "New episode" are
[P1](#p1).

**3D units** (`desk-*`) are files the 3D-Editor's desk writes, format `3d-editor.desk-unit` version 1, described in
the 3D-Editor's [embedding contract](https://github.com/sloth-os/3D-Editor/blob/main/docs/embedding.md#library-units).
Rideo stores them, serves them and reads only their 16-byte prefix and JSON header (the magic `3DUNIT` CR LF, the
container version 1, the header's length, then `format`, `version` and `kind`) to check what an upload claims. It
never inflates a unit's body, and it never reads a desk state.

## Storage

The library is studio data, kept on the storage backend next to the brand kits (`<root>` is `RIDEO_WEBDAV_ROOT`,
default `/rideo`):

```
<root>/library/
├── items/<lib_id>.json         the item's head: what pickers list; rewritten on every change of the item
├── items/<lib_id>/v0001.json   one manifest per version (v0001 … v1000): written once, never changed
└── files/<aa>/<sha256>         every file of every version, named by its sha256 (aa: its first two characters)
```

- **Heads** are read into memory on first use (8 at a time; an invalid head is skipped with a warning, as brand kits
  are; a head that cannot be read fails the call with a retryable `storage_error`, and the next call reads every head
  again, so an item is never left out while a save would make a second one), **manifests** on demand (the last 256 stay
  in memory), **files** are streamed.
- **One file per content.** The same bytes in two versions or two items are stored once; a file is written only when
  its path is missing, and never changed. Nothing is collected: like project objects and media
  ([garbage collection](version-control.md#garbage-collection)), measure before writing a collector.
- **One place builds the paths**: `packages/server/src/storage/layout.ts` (`libraryItem(id)`, `libraryVersion(id, n)`,
  `libraryFile(sha256)`), ids checked with `assertId`, hashes and version numbers by pattern.
- **Every storage mode.** On WebDAV (embedded or external) the library is a folder like `brand-kits/`. When projects
  live in browsers, `RoutedStorage` keeps everything outside `projects/` and `trash/` in the data directory
  (`<dataDir>/dav`), so the library is studio-wide whichever browser holds a project
  ([browser storage](browser-storage.md#routing-on-the-server)).
- **Concurrency.** Every change of an item runs under a lock of that item in the one server process. A manifest is
  written with `If-None-Match: *` where the backend supports it (else after a `stat`, under the lock); a manifest a
  crash left without its head is skipped, so version numbers always increase but may have gaps.

### The item

```ts
type LibraryItem = {
  id: string;                         // lib_…
  kind: 'character' | 'element' | 'resource' | 'desk-set' | 'desk-prop' | 'desk-figure';
  name: string;                       // 1–120 characters
  description: string;                // at most 2000
  tags: string[];                     // at most 20, lower case: [a-z0-9][a-z0-9 _.-]{0,39}
  entityId: string | null;            // characters and elements: the chr_/ele_ id of the first save
  current: number;                    // the version pickers and Use in project take
  latest: number;                     // the highest version
  history: {                          // every version, newest last
    version: number; digest: string; basedOn: number | null; note: string;
    realPerson: boolean; bytes: number; createdBy: Author; createdAt: string;
  }[];
  thumbnail: { version: number; hash: string; mime: 'image/png'; width?: number; height?: number } | null;
  unit: {                             // 3D units: the current version's unit file; null for the other kinds
    sha256: string; bytes: number; format: string; formatVersion: number;
    actorKind: string | null; heightM: number | null; dimensionsM?: [number, number, number];
  } | null;
  realPerson: boolean;                // the current version shows a real person (a likeness or a cloned voice)
  archived: boolean;                  // hidden from pickers; still served; pins and links keep working
  ownerId: string;                    // who created it (an agent token's owner for agents)
  createdBy: Author; createdAt: string; updatedBy: Author; updatedAt: string;
  rev: number;                        // the head's revision: its ETag is "r<rev>"
};
```

The list answers summaries: the head without `history`, with `versions` (how many); a 3D unit's `unit` is the
current version's file, so a picker shows a figure's kind and height and a unit's size without reading a manifest.
The list leaves archived items out unless `archived` is `true` (then it lists them too).

### A version

```ts
type LibraryVersion = {
  itemId: string; version: number;    // 1, 2, 3… per item, given by rideo; at most 1000 versions an item
  kind: LibraryItem['kind'];
  digest: string;                     // 3D units: the unit file's sha256; others: the snapshot digest (below)
  payload: CharacterSnapshot | ElementSnapshot | ResourceSnapshot | DeskUnitSnapshot;
  thumbnail: LibraryMedia | null;
  basedOn: number | null;             // the version it was made from
  note: string;                       // at most 500 characters
  source: { projectId: string; entityId: string; commit: string | null } | null;  // saved from a project
  realPerson: boolean;
  bytes: number;                      // the version's files, its thumbnail included
  createdBy: Author; createdAt: string;
};

type LibraryMedia = { hash: string; mime: string; size: number; name: string;   // a MediaRef without a project path
                      width?: number; height?: number; durationSec?: number; … };
type DeskUnitSnapshot = { format: '3d-editor.desk-unit'; formatVersion: number; payload: LibraryMedia;
                          meta: DeskUnitMeta };
```

- **Character and element snapshots** hold the entity's library-owned content: for a character its name, role,
  summary, identity, wardrobe (ids kept), personality, approved references (ids, views, wardrobe ids and consent
  records kept; candidates and unapproved references left out), voice (candidates left out), seed, whether it was
  locked, and its 3D pin without `pinnedAt` and `pinnedBy`; for an element its kind, name, description, aliases,
  approved references, seed, whether it was locked and its pin. Their media are library files.
- **A resource snapshot** holds its kind, role, name, notes and media.
- **`DeskUnitMeta`** is the desk's publish `meta` as the protocol bounds it: `dimensionsM`, `objects`, `triangles`,
  `actor: {kind, heightM} | null`, `credits` (at most 32), `deskVersion` and `digest`, at most 16 KiB of JSON
  ([library units](director-desk.md#publishing-and-linking)).

### The three hashes

| Hash | Of | Where it goes | What it is for |
|---|---|---|---|
| The unit file's **sha256** | the exact bytes of a 3D unit file | a 3D version's `digest` and its file's name, the file route's `ETag`, the entity's pin (`deskUnit.sha256`), the brief's pins, `open.units`, `unit-publish`, the rows of `state.units` | the identity of a unit version on the wire: the bridge and the desk both check bytes against it |
| Rideo's **snapshot digest** | `sha256(canonicalJson(libraryDigestInput(kind, payload)))` of a character, element or resource version, leaving out reference ids, wardrobe ids, `createdAt` and `consent.recordedAt` | the version's `digest`, the entity's `library.digest` | a save that changes nothing makes no version; status `modified` (edited in this project since); it never leaves rideo |
| The desk's **body digest** | the unpacked body of a unit (the 3D-Editor's `header.digest`) | inside the unit's header, and the publish `meta.digest` | the desk's own checks; rideo keeps it as given and never compares it |

### Versions and revisions

- **A version is never changed.** A save or an upload adds the next number; the item's `latest` and `current` move to
  it: a new version becomes current at once, whoever published it (audited, [below](#audit)). A save or an upload
  whose digest is the current version's makes no version: `200` with `unchanged: true`.
- **`basedOn` is a precondition.** A new version may name the version it was made from; when that is not the item's
  `latest` (someone published meanwhile), nothing is written and the answer is `412` `library_conflict` with
  `errors: [{latest}]`. The desk's "Save as a new version of Harbor v2" sends it, and so does Save to library of an
  entity linked at a version.
- **The head's revision.** Every change of the head (a version, a rename, tags, `current`, archive) increases `rev`.
  `GET` answers `ETag: "r<rev>"`; `PATCH` and `POST …/versions` take `If-Match` (MCP: `expectedRev`), and a stale one
  is `412` `library_conflict` with the current `ETag`.
- **`current` may go back.** The item's manager (owner or admin) can make an older version current: pickers and Use in
  project then take it; projects keep the versions they use.

## Copy on apply

Project documents never point at library bytes. Characters, elements and resources are **copied** into a project, and
saved by copying back; the link between the two is metadata on the entity:

```ts
entity.library: {
  itemId: string; version: number; digest: string;   // the library version the entity came from or was saved as
  mode: 'saved' | 'used' | 'linked' | 'updated';
  at: string; by: Actor;
} | null                                             // on Character, Element and Resource; absent or null: none
```

So history, restores, branches, WebDAV work trees, browser storage, renders and project files see only project media,
as before. 3D units are the exception: they are [pinned](#pins-on-entities), and their bytes stay in the library.

### Save to library

`POST /api/projects/:id/library/save` (`library_save`) `{entity: {kind: 'character' | 'element' | 'resource', id},
itemId?, newItem?, name?, description?, tags?, note?, basedOn?, acknowledgeConsent?}`:

- **Which item.** A new item when the entity has no library link, or with `newItem: true` (which wins over `itemId` and
  the link): its kind's, named after the entity unless `name` says otherwise, with `entityId` the entity's id. Otherwise
  a new version of `itemId` (`404` when there is no such item), or of the item the entity is linked to
  (`entity.library.itemId`); a kind that is not the item's is `422`. Save of a linked
  entity sends `basedOn` = its linked version, so a version someone published meanwhile is never buried
  (`412` `library_conflict`; the dialog then offers **Update…** first, **Save anyway** as the next version, or **Save
  as a new item**).
- **What is saved** is the entity as it is at the project's tip ([a version](#a-version)); its files are copied from
  the project's media into `library/files` (each once).
- **The project** records the link in the same request, one commit: `Save Mira to the library (v2)`, with
  `entity.library.mode` `saved`. A save that changes nothing (`unchanged`) still links.
- **Real people.** A version whose approved references or cloned voice show a real person needs
  `acknowledgeConsent: true`: the person saving confirms that the consent's scope covers using that likeness or
  voice in other projects of the studio. Without it: `consent_required` (422), with each subject and scope in `errors`.
  Consent records travel inside the version as recorded, with who recorded them and when
  ([consent records](provenance.md#consent-records)).

### Use in project, Update and Link: apply

`POST /api/projects/:id/library/apply` (`library_apply`) `{itemId, version?, target?, relock?, replacePin?,
acknowledgeConsent?, dryRun?}` applies a version (`version`, else the item's `current`):

| Mode | When | What it writes |
|---|---|---|
| `create` (Use in project) | a character, element or resource item, no `target` | a new entity |
| `update` | a `target` linked to this item | the target's library-owned content |
| `link` | a `target` not linked to it (a character the writer made, say) | the same as `update`, and the link |
| `pin` | a 3D unit item, with its `target` | the target's `deskUnit` ([pins](#pins-on-entities)) |

An archived item cannot be applied to an entity that does not use it yet (`409` `conflict`): unarchive it first; the
entities that use it can still move to another of its versions. `replacePin` (default `true`) lets a pin replace
another item's pin on its target. `dryRun: true` answers the plan and writes nothing; it asks for neither
`acknowledgeConsent` nor `project.approve` (the plan's `realPerson` and `needs` say what the apply will ask), so an
editor sees the plan of an update a director has to make. An apply reuses the files the project already holds (by
sha256) and copies the others. Every apply is one commit:
`Use Mira from the library (v2)`, `Update Mira from the library (v2 → v3)`, `Link Mira to the library (v3)`,
`Use the 3D set Harbor v3 for Harbor`.

**Create keeps the identity** (a character and an element alike):

- **The id** is the item's `entityId` when no entity of the project has it. When one does (the same character used
  twice, or an episode copied from another), the answer is `409` `conflict` `{reason: "exists", entityId}`, and the
  picker offers **Link to the existing Mira** (apply with that `target`).
- **The name**: a character's name (case-insensitive), or an element's kind and name, that another entity of the
  project has: `409` `conflict` `{reason: "name", entityId}`, with the same offer. An alias that collides only warns.
- **Copied as they are**: the seed, the wardrobe ids, the reference ids, the approved references (approved), the
  consent records, the voice, and the 3D pin (with the apply's `pinnedAt` and `pinnedBy`).
- **Lock versions are the project's.** The entity is locked only if the version was saved locked, at
  `lock.version` = 1 + the highest version any take or board of this project recorded for that id (`characterLocks`,
  `elementLocks`), with `identityHash` computed again; the voice lock the same way, from the `voiceLocks` of take
  audio and dubs. A take of the project made from an older entity of the same id is therefore never current by
  accident (R6, E6, V6, R9).
- **Resources** always become a new resource (new id, origin `library`): shots name resources by id for start
  frames, end frames and motion references, so a library resource is never swapped under a shot.
- **Files** are copied from `library/files` into the project's media under their usual names (`media/refs/…`,
  `media/uploads/…`).

**Update and link** replace the target's library-owned content: name, role, summary, identity, wardrobe,
personality, references, voice and seed for a character; name, description, aliases, references and seed for an
element; and the 3D pin when the version has one (a version without a pin leaves the entity's pin as it is). When the
target and the version are both locked and `relock` is on (the default), the lock version stays when the identity hash
is unchanged and goes up by one otherwise: the rules R2 and E2 already use, so R6, E6 and V6 make exactly the takes that
used the old identity stale. `relock: false` on a locked target, or an unlocked version applied onto a locked target,
is refused with `character_locked`, `element_locked` or `voice_locked` (409).

**The plan** is what a dry run answers and every apply returns:

```ts
type LibraryApplyPlan = {
  mode: 'create' | 'update' | 'link' | 'pin';
  item: { id: string; kind: LibraryItem['kind']; name: string; version: number; digest: string; current: number };
  entity: { kind: 'character' | 'element' | 'resource'; id: string; name: string; exists: boolean };
  keepsLibraryId: boolean;            // create: the entity gets the item's chr_/ele_ id
  changes: ('name' | 'role' | 'summary' | 'identity' | 'wardrobe' | 'personality' | 'references' | 'voice'
            | 'description' | 'aliases' | 'seed' | 'deskUnit' | 'media')[];
  lock: { locked: boolean; from: number | null; to: number | null };
  voiceLock: { locked: boolean; from: number | null; to: number | null } | null;
  staleTakes: number;                 // takes the apply makes stale
  approvedClips: { id: string; index: number; title: string }[];   // approved clips whose selected takes go stale
  localChanges: boolean;              // the entity was edited here since its version: those edits are replaced
  realPerson: boolean;                // needs acknowledgeConsent
  files: { count: number; bytes: number; toCopy: number; bytesToCopy: number };
  warnings: string[];
  needs: 'project.edit' | 'project.approve';
};
```

- **Approved clips need a director.** When `approvedClips` is not empty the apply needs `project.approve` (checked
  in the service, and again inside the commit); an editor gets `403` `forbidden`, audited `auth.denied`. Approvals are
  never taken back: the approved clips keep their takes, and export stays blocked by R7 until those takes are
  generated again ([character consistency](character-consistency.md)).
- **Real people.** Applying a real-person version needs `acknowledgeConsent: true`, as saving one does.

### Detach

`POST /api/projects/:id/library/detach` (`library_detach`) `{target: {kind, id}, what: 'library' | 'deskUnit'}`:
`library` clears the entity's link (it stays as it is, an entity of the project's own), `deskUnit` removes its pin
(its scenes go back to the words at their next **Update shots**). One commit each.

### Status

`GET /api/projects/:id/library` (`library_status`) lists the project's links and pins:

```ts
type LibraryProjectStatus = {
  links: {
    entity: { kind: 'character' | 'element' | 'resource'; id: string; name: string };
    via: 'library' | 'deskUnit';
    itemId: string; version: number;
    // null: an item this studio does not have
    item: { name: string; kind: LibraryItem['kind']; current: number; archived: boolean } | null;
    state: 'current' | 'behind' | 'ahead' | 'missing';   // the version against the item's current
    modified: boolean;                                   // library links: edited here since that version
  }[];
  behind: number;
};
```

## Pins on entities

A character pins its 3D figure; a location element its 3D set; a prop element its 3D prop. A style has none.

```ts
character.deskUnit / element.deskUnit: {
  kind: 'desk-set' | 'desk-prop' | 'desk-figure';   // location: desk-set; prop: desk-prop; character: desk-figure
  itemId: string; version: number;
  sha256: string;               // the unit file's sha256: the version's digest
  name: string;                 // the item's name when it was pinned
  actorKind: string | null;     // figures: the figure's actor kind, from its publish meta; else null
  heightM: number | null;       // figures: its height in metres, from its publish meta; else null
  pinnedAt: string; pinnedBy: Actor;
} | null                        // absent or null: none
```

- **Shape, not identity.** The identity hashes leave pins out: a pin can change while the entity is locked, never
  bumps a lock version and never makes a take stale. What a pin changes is the scene the desk stages.
- **A pin names a version**, never "the latest": a new version reaches a project only when someone moves its pin.
- **Pinning** is an apply in mode `pin`, with a target (`422` for a set on a prop, anything on a style, or no
  target). It is made from the entity's **3D** row, from **Use vN** in an item's Used in list, by the desk's
  publish-and-link ([library units](director-desk.md#publishing-and-linking)), and by Use in project or Update of a
  character or element whose version carries a pin. The desk's link sends `replacePin: false`, so it never re-points an
  entity that pins another item (`409` `conflict` `{reason: "pinned", itemId}`).
- **Unpinning** is a detach of `deskUnit`.
- **Bytes stay in the library.** A pin is never copied into project media: every clip's desk state already holds its
  own materialised copy of what it staged, and the next open fetches the unit from the library. A pin whose item this
  studio does not have (a project imported from another studio) shows as missing, and the desk stages that slot from
  the words.

### How a new version reaches the scenes

1. **Moving a pin is a commit of one project**: a publish-and-link from the desk, the 3D row's **Use v3** or
   **Change**, an Update of a character or element whose version carries another pin, or **Use v3** in the item's
   Used in list (one apply per project; **Use v3 in all 4 projects** runs them one after the other in the browser and
   lists what each answered).
2. **Nothing else happens then**: no desk state is read or written, and nothing stages anything on a server.
3. **Each scene shows it**: the Storyboard's 3D badge reads "3D: v3 available" from what the clip's stored state uses
   ([drift](director-desk.md#drift-the-storyboard-badge)).
4. **The next time the scene's desk opens**, rideo sends the new pin and its unit; the desk lists the change in its
   banner, and **Update shots** applies it as one undo step, keeping the parts edited by hand.
5. **Approved clips keep their stored state**, and their badge says so: "approved: keeps v2".

There is no job that updates stored states across scenes or projects in P0
([server calls](#server-calls-to-the-3d-editor)).

## Where it is used

A project's **digest** (`.rideo/summary.json`, what the project list reads) gains an optional `library` field; the
digest stays version 1, and a digest without the field means "not computed yet":

```ts
ProjectDigest.library?: {
  itemId: string; version: number;
  via: 'library' | 'deskUnit' | 'deskState';
  entity?: { kind: 'character' | 'element' | 'resource'; id: string; name: string };  // library and deskUnit rows
  clips?: number; approved?: number;  // deskState rows: clips whose stored state uses the version, approved among them
}[]                                   // at most 1000 rows
```

- `library` rows are links, `deskUnit` rows pins, and `deskState` rows what the clips' stored desk states use
  (`clip.deskState.units`, staged `unit`), per item version.
- **Filled lazily.** Every new digest computes it (`libraryUses(docs)`, shared and pure); a stored digest without it
  is completed the first time a where-used question needs it, through the registry's bounded digest loads (8 projects
  at a time), and kept. An upgrade rebuilds nothing studio-wide.
- `GET /api/library/items/:itemId/uses` (`library_uses`) answers `{incomplete, projects: [{projectId, title, role,
  uses}]}`: the projects the caller may read that use the item, read with the request's workspace set aside so that
  every attached browser counts. `incomplete` is true when a project could not be read (storage failing, a browser
  project whose tab is closed), and always when projects live in browsers (browsers that are not attached cannot be
  seen).

## Permissions

`libraryAllows(subject, action, ownerId?)` (`packages/shared/src/accounts`, shared by the server and the web app, which
hides what a person may not do):

| Action | Who | Covers |
|---|---|---|
| `read` | any authenticated caller: people, the studio token, agent tokens of any role and projects | list, get, versions, files, where-used (only the projects the caller may read) |
| `publish` | signed-in people, the studio principal, and agent tokens with role `editor` or higher and no project list (`projectIds: null`) | create an item, add a version (uploads, Save to library, the desk's publish) |
| `manage` | the item's owner (the person, or that person's unscoped editor tokens) or an admin (never through a token) | rename, describe, tags, the current version, archive and unarchive |

- A token limited to some projects reads the library and applies to those projects, but never publishes studio-wide.
- **Project routes** (`/api/projects/:id/library…`) take their permission from the route table like every project
  route: `project.read` for status, `project.edit` for save, apply and detach. Save also needs `publish`. An apply
  whose plan lists approved clips needs `project.approve`, checked in the service.
- Studio routes and the MCP tools without a `projectId` have no project to check: the service checks `libraryAllows`
  itself, records `auth.denied` and answers `403` `forbidden`.
- Without accounts (modes `none` and `token`) the configured user is an admin and may do everything
  ([accounts](accounts.md)).

## Limits

| What | Limit |
|---|---|
| Names, descriptions, notes | 1–120 characters; at most 2000; at most 500 |
| Tags | at most 20 an item, each 1–40 characters, lower case, starting with a letter or digit: letters, digits, space, `_`, `.`, `-` |
| Versions | at most 1000 an item |
| A list page | at most 200 items (`limit`, default 100), then `cursor` |
| A 3D unit file | at most 32 MiB (33554432 bytes, the desk's `capabilities.units.maxBytes`); format `3d-editor.desk-unit`, `formatVersion` 1–1000; a header of at most 64 KiB |
| Desk meta | at most 16 KiB of JSON, at most 32 credits |
| An uploaded thumbnail | PNG only, at most 64 KiB and 256 px a side (its signature and `IHDR` are checked) |
| Resource files | images at most 50 MiB, LUTs 16 MiB, audio and video 4 GiB |
| A version's references | characters at most 32, elements at most 16 (approved ones) |
| Units in one desk open | at most 81 (1 set, 16 cast members, 64 elements) and 48 MiB in all |
| Where-used rows | at most 1000 a project |

Character, element and resource versions get a thumbnail the server makes: a PNG of at most 256 px a side from the
first approved reference (by view priority), an image resource's picture or a video resource's poster; audio and LUTs
have none. 3D units bring the desk's own (rendered in the browser when it publishes).

## Surfaces

REST and MCP call the same `LibraryService` (`packages/server/src/domain/library.ts`); inputs and outputs are zod
schemas in `packages/shared/src/schemas/library.ts`.

| REST | MCP |
|---|---|
| `GET /api/library/items` `?kinds&kind&tag&q&archived&sort&limit&cursor` | `library_list` (read-only) |
| `POST /api/library/items` (multipart) | – (bytes are uploaded over REST only) |
| `GET /api/library/items/:itemId` | `library_get` `{itemId, version?}` (read-only; with `version`, also that version's manifest) |
| `PATCH /api/library/items/:itemId` `{name?, description?, tags?, current?, archived?}` | `library_update` `{itemId, …, expectedRev?}` |
| `POST /api/library/items/:itemId/versions` (multipart) | – |
| `GET /api/library/items/:itemId/versions/:version` | `library_get` with `version` |
| `GET /api/library/items/:itemId/versions/:version/files/:sha256` | – (bytes) |
| `GET /api/library/items/:itemId/uses` | `library_uses` (read-only) |
| `GET /api/projects/:id/library` | `library_status` (read-only) |
| `POST /api/projects/:id/library/save` | `library_save` |
| `POST /api/projects/:id/library/apply` | `library_apply` |
| `POST /api/projects/:id/library/detach` | `library_detach` |

There is no delete: items are archived ([P1](#p1)). The rows of every route are in the
[REST reference](../api/rest.md#library).

**Uploads** (`POST /api/library/items` and `…/versions`) are multipart: the part `meta` first (JSON), then the file
`payload`, then an optional `thumbnail`:

```ts
type LibraryUploadMeta = {
  kind: 'desk-set' | 'desk-prop' | 'desk-figure' | 'resource';  // characters and elements are saved from projects
  name?: string;                    // required to create an item
  description?: string; tags?: string[]; note?: string;
  basedOn?: number | null;          // a new version: the version it was made from (412 if not the latest)
  unit?: { format: '3d-editor.desk-unit'; formatVersion: number; meta: DeskUnitMeta };   // 3D units
  resource?: { kind: ResourceKind; role: ResourceRole; name: string; notes?: string; probe?: Probe };  // resources
};
```

An upload that is refused whatever its parts is answered before they are read, and nothing of it is written: a caller
who may not publish gets `403` `forbidden`, a new version of an item that is not there `404`; the rest of the request is
read and thrown away. Each part is counted as it streams to a temporary file: a part over its limit is `413`, `meta`
that is not first or does not validate is `422`. An upload the client abandons in the middle ends there: its temporary
files are removed and nothing is published. A unit file whose prefix or header is not a desk unit's, whose `format` is
not `3d-editor.desk-unit`, or whose header `kind` is not the item's (`set`, `prop`, `figure` for `desk-set`,
`desk-prop`, `desk-figure`) is `422`. A thumbnail must carry the PNG signature and an `IHDR` of at most 256 × 256. An
image resource is taken by its bytes: a PNG, JPEG, WebP, GIF, BMP or TIFF (the stills rideo's media probe reads), kept
with that type whatever its part says; anything else, an SVG or a page among them, is `422` (`reason: payload`).

**The file route** serves any file a version names, with `Range` (`206`), `ETag` (its sha256), `304` on `If-None-Match`,
and `Cache-Control: private, max-age=31536000, immutable`: a version's files never change, so the browser's HTTP cache
serves a unit the second time a desk opens. Like a project's media, every file is sent with `X-Content-Type-Options:
nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`: whatever a file holds, a browser that opens it as a
page runs nothing of it in the studio's origin. A sha256 the version does not name is `404`.

### Errors

| Code | Status | When |
|---|---|---|
| `library_conflict` | 412 | an `If-Match` (MCP `expectedRev`) that is not the item's revision (the answer's `ETag` is the current one); a new version whose `basedOn` is not the item's latest (`errors: [{latest}]`) |
| `conflict` | 409 | Use in project when the item's id is taken in the project (`errors: [{reason: "exists", entityId}]`) or its name is (`{reason: "name", entityId}`); a pin with `replacePin: false` on an entity that pins another item (`{reason: "pinned", itemId}`); an archived item applied to an entity that does not use it |
| `not_found` | 404 | the item, the version, a file the version does not name, the target entity |
| `validation_error` | 422 | a body, query or `meta` that fails its schema, parts out of order; a unit file that is not one or not of the item's kind; an image resource whose bytes are not a raster picture (`reason: payload`); a thumbnail that is not a PNG or over 256 px; a 3D item applied without a target or to the wrong one (a set on a prop, anything on a style); a version of another kind than its item |
| `validation_error` | 413 | a part over its limit: a unit over 32 MiB, a thumbnail over 64 KiB, a resource file over its kind's limit |
| `forbidden` | 403 | `libraryAllows` refuses; the project's permission (read, edit, approve when the plan lists approved clips) |
| `consent_required` | 422 | a real-person version saved or applied without `acknowledgeConsent` |
| `character_locked`, `element_locked`, `voice_locked` | 409 | `relock: false` on a locked target, or an unlocked version onto a locked one |
| `storage_offline` | 503 | a project kept in a browser whose tab is closed (retryable) |
| `storage_error` | 503 | a library file that cannot be read or fails its hash check |

`library_conflict` is the one new code; everything else reuses the codes the [REST reference](../api/rest.md) lists.

### Audit

| Event | When | Detail |
|---|---|---|
| `library.publish` | an item created, a version added (an upload, Save to library, the desk's publish): the new version becomes current | `itemId`, `kind`, `version`, `realPerson`, and the project when saved from one |
| `library.apply` | Use in project, update, link, pin | `itemId`, `version`, `mode`, the entity, `realPerson`, the project |
| `library.change` | archived, unarchived, the current version changed by hand | `itemId`, what changed, from and to |

Real people are recorded as `realPerson: true`, never by name. Refusals are `auth.denied`, as everywhere.

## Observability

| Metric | Type | Labels | What |
|---|---|---|---|
| `rideo_library_total` | counter | `event` (`created`, `version`, `unchanged`, `conflict`, `refused`, `saved`, `used`, `updated`, `linked`, `pinned`, `detached`, `archived`, `unarchived`, `current`), `kind` (the item's: `character`, `element`, `resource`, `desk-set`, `desk-prop`, `desk-figure`, so a 3D pin's unit when it is detached; the kind a refused upload claims, or `unknown`) | library operations |
| `rideo_library_bytes_total` | counter | `op` (`upload`, `from_project`, `to_project`) | bytes written to the library and copied into projects |
| `rideo_library_apply_seconds` | histogram | `op` (`save`, `apply`) | how long a save or an apply took |
| `rideo_library_items` | gauge | `kind` | items in the library |

Logs carry `itemId`, `kind`, `version`, and the `projectId` and entity when a project is involved: `library item
created`, `library version added`, `library version unchanged`, `library conflict` (the `If-Match` or `basedOn` sent
and the latest), `library upload refused` (the reason: `order`, `meta`, `size`, `unit`, `kind`, `thumbnail`, `payload`),
`library saved`, `library applied` (the mode, stale takes, approved clips), `library detached` and `library item
changed`.

## Browser storage and offline

- **The library is studio data** in every storage mode: in browser mode it lives in the server's data directory, not
  in any browser, so every browser of the studio sees the same library.
- **Library operations** (list, get, upload, change, files) never touch a project. **Project operations** (save,
  apply, detach, status) read and write the project where it is, a browser project through its tab: an agent acting on
  a browser project whose tab is closed gets `storage_offline` (503, retryable), as for every project operation.
- **Offline** (the installed app without its server): the Library page, Save and Use need the server and say so.
  What was used in a project is project media and works offline as before. A scene whose desk opens offline gets its
  pins but not their units: the desk stages those slots from the words, records them `pending`, and the next open
  sends the units ([library units](director-desk.md#when-a-unit-does-not-arrive)). The service worker sends every
  `api/` request to the network, so library files are cached only by the browser's HTTP cache.

## The UI

### The Library page

`/library`, from the header's **Library** link next to **Brand kits**.

- **Desktop**: two panes. The list has kind chips (**All**, **Characters**, **Places & props**, **Resources**,
  **3D sets**, **3D props**, **3D figures**), a tag filter (the tags of the items listed), search (names, descriptions,
  tags) and **Show archived** (archived items then show with an "archived" badge).
  The detail (`/library/:itemId`) shows the thumbnail, name, description and tags (editable by the owner and admins,
  an `If-Match` on the item's revision: a change made meanwhile reloads the item and says so), what the current
  version is (a character's role and summary, an element's kind and other names, a resource's kind and role, a 3D
  unit's figure kind and height, size and objects), the versions (vN, date, author, note; the current one marked;
  **Make current** for the owner and admins) and **Used in**: the projects, each with the entities that use the item
  and the version each uses, linking to their view, and for 3D units how many clips' stored desk states use each
  version. For 3D units each project row whose pins are at another version has **Use v3**, and **Use v3 in all 4
  projects** (the projects with such pins) applies the pin project by project, one apply per entity, and lists what
  each answered (now uses v3, refused with the reason, or a project this person may not edit, skipped). The detail
  ends with **Archive** or **Unarchive**; the archived item stays open, gone from the list unless **Show archived**.
- **Phones**: the list, then the detail on its own route (with a link back to the list) and a bottom action bar holding
  **Use v3 in all 4 projects** and **Archive** or **Unarchive**; no sideways scroll.
- The page uploads nothing: characters, elements and resources are saved from their projects, 3D units from the desk.

### Cast, Elements and Resources

- **Save to library** on every character card, element card and ready resource: a dialog with the name, description,
  tags and a note, "Save as a new version of Mira v2" when the entity is linked (else a new item; "Save as a new item"
  is offered beside it), and, for a real person, a checkbox "The consent covers using this likeness and voice in other
  projects of the studio" that Save waits for (a `consent_required` refusal shows it too, with the people it names).
  Its answer says what happened: "Saved Mira v3 to the library" or "Nothing changed since v2". A version saved
  meanwhile (`412`) offers **Update…**, **Save anyway as v4** or **Save as a new item**; refusals are said in words
  from their code.
- **Use from library** in each of the three views (Footage too): a multi-select picker of the view's kinds (in
  Elements, chips for locations, props and styles, read from each item's current version), filtered by tag and
  searchable, archived items left out, the items the project already uses marked. **Use** applies the chosen items one
  by one and lists the results; an item whose id or name is taken offers **Link to the existing Mira**, which shows
  its plan first; a real-person item asks for the consent first.
- **The library row** on a linked entity: "Library: Mira v2 · v3 available [Update…] [Unlink]", with "edited here since
  v2" when the entity changed in this project after it was linked (a library character unlocked and described again,
  say). **Update…** opens the plan: what changes, the lock version before and after, how many takes go stale, the
  approved clips that need a director (an editor sees them and cannot update), that edits made here since v2 are
  replaced, and the consent checkbox for a real person. On a resource the row offers **Use v3** instead, which adds v3
  as a new resource (shots keep the one they name). **Unlink** keeps the entity as the project's own.
- **The 3D row** on characters, locations and props (after the summary on a character, after "Also called" on an
  element): "3D figure: Mira look v1 · v2 available [Use v2] [Change] [Unlink]", or "3D set: none [Choose…]". The
  picker lists the matching kind only (figures for characters, sets for locations, props for props). There is no 3D row
  on a style; it is read-only for people who may not edit the project; a pin whose item this studio does not have reads
  "3D set: Harbor v3 (not in this studio's library)" with **Change** and **Unlink**.

### The Storyboard and the desk

- Each scene row of the Storyboard view has a **3D badge** when a pinned unit needs attention: "3D: v3 available",
  "3D: waiting", "3D: can't use Harbor v3" or "approved: keeps v2", with a tooltip listing every pinned set, prop and
  figure of the scene and its state ([drift](director-desk.md#drift-the-storyboard-badge)).
- The desk's **Library** tab and its **Save to library…** dialog belong to the desk (the 3D-Editor's); rideo's desk
  panel says what a publish did, in its status line and a toast: "Saved Harbor v3 to the library; linked to the
  scene's place (Harbor)", "Saved Harbor v1 to the library; not linked: Harbor uses another library set (Old harbor)",
  "Not saved to the library: …".

Every new control follows [the brand](../brand.md): the library row and the 3D row are `secondary` controls in the
card, badges use the status colours (`info` for available, `warning` for waiting, `danger` for can't use, muted text
for approved), and every view and dialog works at 360 px without sideways scroll.

## Reusing sets, props and characters across episodes

A season of a show about Mira, a harbour pilot. Episode 1 is made as usual; the library carries her, her harbour and
its 3D set into episode 2.

1. **Make episode 1 as usual**: lock Mira in the Cast view, the Harbor (a location) and the brass key (a prop) in the
   Elements view.
2. **Save the 3D set and figure from the desk.** Open a Harbor scene in the Storyboard view with **Director's desk**
   and stage it. In the desk's **Library** tab, **Save to library…** with *What: the set*, name "Harbor": the panel
   says "Saved Harbor v1 to the library; linked to the scene's place (Harbor)". Select Mira's actor and save her too
   ("Mira look"): it links to Mira. From now on every Harbor scene of episode 1 stages on that set, and Mira on her
   figure.
3. **Save the cast and places.** **Save to library** on Mira's card, with the tag `season 1`; if Mira is played by a
   real person, tick that the consent covers the other episodes. Do the same for the Harbor and the brass key in the
   Elements view. Mira's version carries her 3D figure, the Harbor's its 3D set.
4. **Start episode 2** as a new project. Before writing it, **Use from library** in the Cast view (Mira) and in the
   Elements view (the Harbor, the brass key), filtered by `season 1`. They arrive with the same ids, seeds and
   approved references, locked as they were saved, and with their 3D pins.
5. **Write episode 2.** The writer is told the project's characters and places and reuses their names, so the scenes
   link to Mira and the Harbor instead of inventing "Mia" and "the old docks".
6. **Stage a scene.** The desk opens with the Harbor set and Mira's figure from the library: nothing is staged from
   the words for them.
7. **Improve the set in episode 2.** Add a lamp post in the desk and **Save to library…**: it offers "Save as a new
   version of Harbor v1". The answer is "Saved Harbor v2 to the library; linked to the scene's place": episode 2's
   Harbor now pins v2, and its other scenes show "3D: v2 available" until their desks open.
8. **Bring v2 to episode 1 when you want it.** On the Library page, Harbor → **Used in** → episode 1 → **Use v2**
   (or **Use v2 in all 2 projects**). Episode 1's Harbor scenes show "3D: v2 available"; opening one, the desk's
   banner lists the new set and **Update shots** applies it in one step, keeping what was moved by hand. Approved
   scenes keep v1 ("approved: keeps v1").
9. **Update Mira.** New references drawn in episode 2? **Save to library** there (v2), then in episode 1 Mira's
   library row says "v2 available": **Update…** shows the plan (lock 3 → 4, 6 takes to generate again, one approved
   clip that needs a director) before anything changes.
10. **Retire what is done.** **Archive** an item on the Library page: pickers no longer offer it, and the projects
    that use it keep working.

## Server calls to the 3D-Editor

The second request was: "rideo backend can directly request to 3D-Editor backend if it can improve efficiency". The
3D-Editor's design for a desk service (D4) measured what a server-to-server call could do:

| Candidate | What it would save | What it costs | Decision |
|---|---|---|---|
| Staging a scene on the 3D-Editor server | 1.7–2.5 s of a scene's first open in the browser: staging a 60-shot brief takes 2.8–3.6 s in the desk's worker (3.8–4.6 s from `open` to `opened`), against 2.0–2.1 s to open from a stored state | 3.4 s and 91 MB of server heap for a 60-shot brief; 24 s and 444 MB for the largest (200 shots, 16 cast members); the heaviest desk work moves onto the shared server | no: heavy work stays in the browser |
| Moving a pin inside stored states (`update-units`) | one desk open and one **Update shots** per scene | about 0.3 s per stored state of 60 shots and 0.9 s at 200, in a process of its own; a blob cache, an auth scope and a second cross-repo contract | P1 (below) |
| Getting unit bytes server to server | nothing: rideo's server sends a unit to the browser, which hands it to the desk in the same tab, one network hop | – | not needed |

There is **no backend-to-backend call in P0**:

- **Rendering stays in the browser** (heavy CPU, GPU and memory work prefers the frontend, so that one 3D-Editor server
  serves many people). A state the server updated yields no new reference clip until someone opens the desk and
  presses Send, and an open desk applies a new pin itself with **Update shots**.
- **Unit bytes already take one hop**: rideo's server → the browser → the desk.
- **The 3D-Editor server's only P0 role is serving the desk's static files**: the best case for "one server, many
  users".
- The two projects stay independent: no second contract, tokens, quotas or version skew between servers.

**When it would pay off**: many stored scenes updated without anyone opening them (a season of 30 scenes on one set,
moved to v4: 30 desk opens and 30 **Update shots** by hand, against one batch of 0.3–0.9 s a scene on the server), and
agents without a browser that move pins and want the stored states to follow. The P1 design is the 3D-Editor's desk
service with one operation, `update-units` (move pins inside a stored state, keeping its lineage so an open desk's copy
still merges), a content-addressed blob cache, an auth scope of its own and a process pool, with rideo's client and
**Update everywhere** for stored scenes. What to weigh then: a server update over a desk that is open ends in the
existing `412` conflict, whose **Replace** would drop the server's change unless the desk reopens and merges.

## Tests

- **Unit (shared):** `library.test.ts`: the schemas of every kind (a payload of the wrong kind, tags, references and
  meta over their limits refused); the snapshot digest the same under new reference ids, wardrobe ids, `createdAt` and
  `consent.recordedAt` and different for another identity, wardrobe text, reference hash, seed or pin; snapshots
  keeping only approved references, with consent records, seeds, wardrobe ids and the pin; `planApply` (create keeping
  the item's id and seed at lock version 1 + the highest recorded; `conflict` for a taken id or name, an alias only
  warned; update relocking by the identity hash; stale takes and approved clips with `needs: "project.approve"`;
  `character_locked`, `element_locked`, `voice_locked`; 3D items onto the right targets only; `replacePin: false`
  refused on another pin; a version without a pin keeping the entity's; resources always created; archived items
  refused); `libraryAllows` for every kind of caller (`accounts.test.ts`); digests with and without `library`, still
  version 1 (`digest.test.ts`); old documents without `library` and `deskUnit` parsing and the new fields
  round-tripping (`documents.test.ts`); a pin changing no identity hash (`library.test.ts`, and with the server's own
  hashes in `library-store.test.ts`).
- **Unit (server):** the store (`library-store.test.ts`, memory and file backends): versions written once, a leftover
  manifest skipped, two versions at once both kept (the item's lock in one server, `If-None-Match` across two), heads
  read once with an invalid one skipped, a head whose read fails failing the load (retryable) until the next call reads
  it, the same bytes stored once, a file failing its hash check; the service on in-memory storage: v1, v2, `unchanged`,
  a stale `If-Match` and a stale `basedOn` answered `412` `library_conflict` with the latest, rename, current version,
  archive; a head the storage cannot read answered with a retryable `storage_error`, the item kept and saved into again;
  a save with `newItem` making a new item whatever `itemId` names; `libraryAllows` through real principals (people,
  admins, scoped, reviewer and editor tokens, an admin's token); a set pinned on a location and a figure on a character
  (no lock or identity hash moved), status and uses following the pin, detach (counted under the detached item's kind: a
  pin's unit, a link's item); an update whose approved clip goes stale planned for an editor, refused to them (`403`,
  audited) and done by a director (lock + 1). Uploads (`library-upload.test.ts`): the multipart parts in order, `meta`
  not first, bad `meta`, a unit of 32 MiB + 1 byte (`413`, counted, its temporary file removed), a thumbnail over 64 KiB
  and `meta` over 32 KiB (`413`), 3D meta over 16 KiB (`422`), a unit with a wrong magic, container, codec, header,
  format, version or kind (`422`), thumbnails that are not PNG or over 256 px (`422`), a client that goes away in the
  middle of a part (the receive rejects, no temporary file left), a raster picture known by its signature (PNG, JPEG,
  WebP, GIF, BMP, TIFF) and an SVG, a page or a video not taken for one, byte ranges.
- **Integration** (`library.test.ts`, REST and MCP on one server): a desk set uploaded, listed, read, served with
  `Range`, `304` and `HEAD`, a new version with a stale `If-Match` and with a stale `basedOn`, renamed, archived (gone
  from the default list, still served), its uses; Mira saved from project A (`consent_required` until acknowledged),
  used in project B with the same id and seed and her references copied, a v2 from A making B's status `behind`, B's dry
  run and update (lock + 1); a name conflict linking instead; a resource used as a new resource; an image resource that
  is an SVG or a page refused (`payload`), a PNG kept as one whatever its part says, and a library file and a project's
  media served with `nosniff` and a sandboxing policy; a figure pinned on a character and a set on a location, detached;
  the audit events and the metrics. MCP's `library_*` tools give the same answers as the routes. With projects in
  browsers: the library in the data directory, an apply through the tab that holds the project, `storage_offline`
  without it. With accounts (`accounts.test.ts`): the library and its project routes kept to their callers however the
  path is percent-encoded, and an upload from a reviewer token answered `403` (an item that is not there `404`) before
  its parts are read, nothing written to the temporary folder.
- **Unit (web)** (`packages/web/test/library-ui.test.tsx`): the rows' texts ("Library: Mira v2 · v3 available", "edited
  here", "3D set: none", a missing pin), the plan in words (lock versions, stale takes, the approval warning and who may
  confirm, local edits, files), refusals in words by code, tags checked, the moves of **Use v3 in all N projects**
  (pins at another version only, reviewers skipped, a refusal listed and the loop going on), and the dialogs on a
  mocked API: Save with the consent box, a `412` offering Save anyway, the plan's approval warning, the picker's "Link
  to the existing Mira"; on the Library page, **Make current** and **Archive** with the item's revision as `If-Match`,
  and a change made meanwhile (`412`) reloading the item and saying so.
- **End to end** (`e2e/library.spec.ts`, desktop and mobile): Mira saved from episode 1 through the consent dialog, used
  in episode 2 (the same id and seed, checked through the API), the writer of episode 2 keeping her (its scenes cast
  her id), a project with a Mira of its own offered "Link to the existing Mira" (its plan, then linked and locked), a
  v2 published from episode 1, the update in episode 2 with its plan and the approval warning of its approved clip,
  the item's Used in; desk units uploaded through the REST API in the test: a location's 3D row Choose (sets only),
  Use v2, the Library page's search, kind chips and tag filter (the list kept beside the item on a wide screen), Use
  v3 for the project and Use v4 in every project, a tag added, a prop archived (gone from the list and the props'
  picker, back under Show archived), Change and Unlink; no sideways scroll. The desk's side of units is in
  [the desk's tests](director-desk.md#tests).

## P1

Documented, not built:

- The desk's **library catalog**: browsing the studio's units in the desk and inserting them by hand (the `library`,
  `unit-request` and `unit` messages, a unit cache in the desk, `lib:` instance keys). The P0 desk's Library tab lists
  only the scene's linked units, with Make local and Save to library.
- **Series** and **New episode** (a project that starts from a series' items).
- **Delete**, refused while an item has uses.
- **Project files carrying pinned units**: a `.rideo` file has the copied characters, elements and resources, but not
  the unit files its pins name.
- The full editor's **export and import of unit files**.
- The desk's staging extras: unit pieces blocking the camera solver, the `inside_set_piece` check, moving actors and
  props that are still as staged when a set updates, and **figure rebuilds** when a figure's kind or height differs
  from the staged actor.
- The 3D-Editor's **desk service** (`update-units`, blobs, info) and rideo's client with **Update everywhere** for
  stored scenes ([above](#server-calls-to-the-3d-editor)).
- **Named stage areas** inside big sets (a dock and a café in one harbour).
- **Flags on reference clips** made from an older unit version.
- **Garbage collection** of library files, once measured.
