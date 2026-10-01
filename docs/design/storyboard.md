# Storyboard and animatic

Storyboard-first is the standard pre-production flow, and it saves money: an image costs a fraction of a video
generation. Rideo already generates a verified keyframe for every shot, so the storyboard makes that step a stage
of its own: the keyframes of the first scenes are generated, reviewed in a grid, reordered and approved **before**
any video is generated. Approved frames become the first frames of the video pass (no second image generation),
their TTS dialogue is reused, and the animatic (frames + dialogue + temp music) is played and exported by the
browser engine.

## Stage and gate

The story workflow gets a `storyboard` stage between `resources` and `pilot`:

| Stage | What happens | Gate | Auto on enter |
|---|---|---|---|
| `storyboard` | Plan the shots of the first `settings.storyboard.scenes` scenes (default 3) and generate a verified frame per shot; review the grid, reorder shots, regenerate frames, approve; play and export the animatic. | `storyboard_approved`: `storyboard.approved` | `storyboard.generate` |

| Requirement | Satisfied when |
|---|---|
| `storyboard.approved` | `settings.storyboard.enabled` is false, or every shot of the storyboarded scenes has an **approved, current** frame (and at least one scene is planned) |

`settings.storyboard = { enabled: boolean (default true), scenes: 1–50 (default 3) }`. Projects past the
`resources` stage when the stage was added see it as done.

## Board frames

`Shot.board` holds the frame of a shot:

```ts
type ShotBoard = {
  keyframe: MediaRef;                  // the verified keyframe image (media/keyframes/)
  createdAt: string; jobId?: string;
  request: { imageModel?: string; prompt: string; seed: number; referenceCount: number };
  promptHash: string;                  // of the keyframe prompt it was generated from
  consistency: ConsistencyReport;      // the judge's evidence (R4), as for takes
  characterLocks: Record<string, number>;
  elementLocks: Record<string, number>;
  audio: TakeAudio | null;             // the shot's TTS dialogue, for the animatic and the video pass
  gatewayTaskIds: string[];
  approved: boolean; approvedAt: string | null; approvedBy: Actor | null;
} | null;
```

`boardState(shot, docs)` is shared by the server, the studio and agents:

| State | When |
|---|---|
| `missing` | no frame yet |
| `failed` | the frame failed the consistency gate after every attempt (regenerate it) |
| `stale` | a character, element or voice was relocked since (R6/E6/V6) |
| `outdated` | the shot was edited since: its keyframe prompt hash differs |
| `unapproved` | current, waiting for review |
| `approved` | current and approved |

Only current frames that did not fail can be approved (`board_unapprovable` otherwise). Editing a shot, reordering
it or relocking what it shows makes the frame `outdated`/`stale` again, so the gate reopens until it is approved
again.

## Jobs

| Kind | Lane | Does |
|---|---|---|
| `storyboard.generate` | control | plan the storyboarded scenes that have no clip (`clip.plan`), then `shot.board` for every shot whose frame is missing, failed, stale or outdated; waits for them |
| `shot.board` | image | R1/E1 preconditions, the keyframe with references, judge and retries (the shot pipeline's keyframe step, shared code), and the shot's TTS dialogue when the server has a TTS provider and every speaker has a locked voice; commits `shot.board` (unapproved) |

## Video pass

In the shot pipeline (`shot.generate`), a shot whose board is **approved and current** skips the keyframe step: the
board's keyframe is the first frame (`take.request.firstFrameSource: 'storyboard'`) and its report is the keyframe
evidence. Continuous shots still start from the previous take's last frame when it is usable (R5), and from their
board otherwise. A board whose dialogue mix is current (same lines, same voice locks) gives the take its TTS audio
without speaking the lines again.

## Animatic

`POST /storyboard/animatic` builds `animatic.json` (a timeline document, versioned like every document) with the
shared `assembleAnimatic`:

- **Video**: one still item per storyboarded shot with a frame, in clip and shot order; its length is the shot's
  planned duration, or the dialogue mix when longer. Fade in at the start, fade out at the end.
- **Dialogue**: the frames' TTS mixes, aligned with their stills.
- **Music**: the chosen music resource (temp music), looped under the film at 0.35.
- **Captions**: the dialogue lines, timed from the mixes when they exist.

Still images are ordinary video items whose media is an image: the render plan loops the image
(`-loop 1 -framerate fps`), the WebCodecs compositor draws it as an `ImageBitmap`, the preview player shows it, and
audio queries skip it. The storyboard view plays the animatic with the editor's player. `POST /exports
{source: 'animatic'}` renders it in the studio tab like any export (watermark and C2PA at the finish; the frames,
mixes and music are its ingredients). Animatic exports carry `source: 'animatic'` and need no consistency gate.

## Screenplay import

`POST /screenplay/import` (multipart `file`, or `{uri}` or `{text, format}`) reads **Fountain**, **Final Draft
(`.fdx`)** and **PDF** screenplays into the screenplay document:

| Format | How |
|---|---|
| Fountain (`.fountain`, `.txt`) | shared `parseFountain`: scene headings (`INT.`/`EXT.`/`EST.`/`INT./EXT.`/`I/E` or forced `.`), action, character cues (upper case, `@` forced, `(V.O.)`/`(O.S.)`/`(CONT'D)` stripped), parentheticals, dialogue, dual dialogue (`^`), title page `Title:`; notes, boneyard and sections are ignored |
| Final Draft (`.fdx`) | shared `parseFdx`: `<Paragraph Type="Scene Heading | Action | Character | Parenthetical | Dialogue">` with their `<Text>` runs |
| PDF | text extracted on the server (`pdfjs-dist`, lines rebuilt from the text positions), then `parseFountain` |

Text before the first scene heading is ignored; a file without a heading is not a screenplay
(`validation_error`). The imported scenes keep their order; each becomes an outline beat with an estimate of one
minute per 55 lines (at least 10 s), and the project's target length becomes the script's. Character cues become
draft characters (the speaker with the most lines is the protagonist; identity to fill in or describe from a
photo), scene headings become draft location elements (a trailing `DAY`, `NIGHT`, `LATER`, … is the time of day),
and dialogue is linked to the characters. An empty brief is named after the script, so the brief gate can be
submitted. The import replaces an existing screenplay (and removes its planned clips) only with `replace: true`,
and never while the screenplay gate is approved.

## Shot list

`GET /shotlist.csv` and `GET /shotlist.pdf` list every planned shot: scene, clip and shot numbers, duration,
framing and movement, characters, location and props, description, action, dialogue, the board state and the
selected take's state. The CSV comes from the shared `shotListCsv` (RFC 4180, UTF-8 with BOM for spreadsheet
apps); the PDF is written by the server (A4 landscape, the standard Helvetica font, one row per shot with the
board frame as a JPEG thumbnail).

## Surfaces

| REST | MCP |
|---|---|
| `POST /api/projects/:id/storyboard/generate` `{sceneIds?}` → job | `storyboard_generate` |
| `POST /api/projects/:id/clips/:clipId/shots/:shotId/board/generate` → job | `shot_board_generate` |
| `POST /api/projects/:id/clips/:clipId/shots/:shotId/board/approve` `{approved}` | `shot_board_approve` |
| `POST /api/projects/:id/storyboard/approve-all` | `storyboard_approve_all` |
| `POST /api/projects/:id/clips/:clipId/shots/reorder` `{shotIds}` | `shot_reorder` |
| `POST /api/projects/:id/storyboard/animatic` `{musicResourceId?, captions?}` | `animatic_build` |
| `POST /api/projects/:id/exports` `{source: 'animatic'}` | `export_render` (`source`) |
| `POST /api/projects/:id/screenplay/import` | `screenplay_import` (`{uri}` or `{text, format}`) |
| `GET /api/projects/:id/shotlist.csv` / `shotlist.pdf` | `shotlist_get` (CSV text) |

Reordering keeps the first shot a `cut` and turns a continuous shot whose predecessor changed into a cut. The MCP
project snapshot carries the storyboard progress and each shot's board state; `shotlist_get` returns the CSV without
its byte-order mark.

The **Storyboard** view (`/p/:id/storyboard`) shows the storyboarded scenes as rows of frame cards (image, shot
number, length, camera, description, lines, state) with approve, regenerate and move earlier/later; the header
generates the storyboard, approves every current frame, and links the shot list downloads; the **Animatic** panel
builds, plays and exports the animatic. The Story view imports a screenplay file.

## Observability

`rideo_storyboard_frames_total{result}` counts frames by gate result; jobs carry the project and shot ids in their
logs. Errors: `board_unapprovable` (409) for approving a missing, failed, stale or outdated frame;
`validation_error` for an import that finds no scene.
