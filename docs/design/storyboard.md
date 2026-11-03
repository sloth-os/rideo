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
  sheet: { keyframe: MediaRef; panel: number; panels: number; drawnFrom?: MediaRef } | null; // its scene sheet (#scene-sheets)
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
| `outdated` | the shot was edited since, or its keyframe prompt changed another way (its scene's continuity, the [prompt version](continuity.md#prompt-version)): its keyframe prompt hash differs. What neighbouring shots lend a prompt (the previous shot's end state, the scene reference image) is not part of the hash, so moving frames does not outdate the others |
| `unapproved` | current, waiting for review |
| `approved` | current and approved |

Only current frames that did not fail can be approved (`board_unapprovable` otherwise). Editing a shot, reordering
it or relocking what it shows makes the frame `outdated`/`stale` again, so the gate reopens until it is approved
again.

## Jobs

| Kind | Lane | Does |
|---|---|---|
| `storyboard.generate` | control | plan the storyboarded scenes that have no clip (`clip.plan`), block each in 3D when `settings.blocking.enabled` (`scene.block` for a scene without a blocking; an incomplete one is completed: [director's desk](director-desk.md)), then `shot.board` for every shot whose frame is missing, failed, stale or outdated: each scene's first shot first, then its other shots in parallel; waits for them. With `settings.storyboard.sheet` a scene whose every frame is drawn gets its `clip.sheet` first, and its shots start from their panels |
| `clip.sheet` | image | [scene sheets](#scene-sheets): the scene's shots drawn together as the panels of one image, up to six a sheet, and cut apart at the gutters; returns each shot's panel |
| `shot.board` | image | R1/E1 preconditions, the keyframe with references, judge and retries (the shot pipeline's keyframe step, shared code), and the shot's TTS dialogue when the server has a TTS provider and every speaker has a locked voice; commits `shot.board` (unapproved). Given a panel of its scene's sheet, the panel is its first attempt, checked like any drawn frame |

**The blocking.** A shot of a blocked scene is drawn with its blocking line in the keyframe prompt and its camera view
as the last reference image ([what the image and video models get](director-desk.md#what-the-image-and-video-models-get)).
The line is part of the prompt hash, so moving a mannequin or a camera makes the frame *outdated*.

**Production scenes.** With `settings.storyboard.production`, every scene the batch makes is storyboarded the same
way before its video, one scene at a time (`clip.storyboard`), and reviewed and approved on its own
([production storyboards](ai-review.md#production-storyboards)); the Storyboard view lists those scenes after the
storyboarded ones, each with its review.

**The scene reference.** With prompt version 2 a later shot's frame gets the scene's first frame as one more image,
as keyframes of the video pass do ([scene reference frame](continuity.md#scene-reference-frame)): a first frame that
is drawn and did not fail (approved or not). The swimming demo drew all sixteen frames of two scenes at once, without
it, and the storyboard review scored their continuity 5 in all three rounds: the watermelon halves wandered from one
side of the beach to the other and onto a blanket, the shoreline and the sun swapped sides. A frame redrawn after the
first one changed keeps the reference it was drawn with until it is drawn again.

## Scene sheets

Frames drawn one at a time do not see each other, and with `settings.storyboard.sheet` (off by default: takes from its panels
[scored lower](first-pass.md#a-scene-drawn-on-one-sheet)) a scene drawn whole is drawn as one image instead: a storyboard sheet whose panels are its shots in order. Seedream 5.0 Pro has no group mode, so one
canvas is the only way its frames can see each other ([why](first-pass.md#a-scene-drawn-on-one-sheet)).

- **When.** `drawBoards` sends a clip to `clip.sheet` when every one of its shots needs a frame, there are at least two
  and at most `SHEET_MAX_PANELS` (8): a scene is drawn on one sheet or not at all, since two sheets of one scene
  disagree with each other as frames drawn alone do (fp27's riding scenes, split four and four: Sammy's helmet changed
  between them). A scene with some frames kept (a review's fixes, an edited shot) or with more shots has its frames
  drawn one at a time, with the scene reference, as before.
- **Layout** (`sheetLayout`, shared). The shots in order, in the grid whose canvas is nearest square, an empty cell
  counting as much as a canvas a third wider than square: two or three 16:9 frames in one column, four in 2×2, five
  or six in two columns of three rows, seven or eight in two columns of four. The canvas is as large as the image
  model draws (`settings.storyboard.sheetPixels`, 4,600,000 by default: Seedream 5.0 Pro refuses more than 4,624,220
  pixels), so six panels are about 1,050×590 pixels each and eight about 900×510. A cell no shot fills shows the
  place alone.
- **Prompt** (`compileSheetRequest`, shared). `A storyboard sheet of N panels in C columns and R rows …` (the
  `SHEET_PROMPT_PREFIX` the mock gateway reads), the style once, the scene line once (without the props none of its
  shots show), then `Panel k (<framing>): <the shot's keyframe description> <who is in frame>.` for each panel, the
  characters' identities and the elements once, the reference images in order (the cast and elements of all its shots,
  `prepareShotReferences` over their union), `No text, numbers, captions or speech bubbles.` and the still's exclusions.
- **Cutting** (`cutSheet`, server). A 960-pixel grey copy of the sheet gives each column's and row's share of
  near-white pixels; the gutters are the runs above 90%, and the panels are the runs between them. When the runs do
  not come out as the grid's columns and rows the sheet is cut into equal cells. Each panel is cut a little inside its
  edges, to the frame's aspect from its middle, and kept at its own size.
- **Checks.** `clip.sheet` reads every panel against its shot (the staging check, `frame.reconcile`, the first panel as
  the others' opening frame). A sheet with a panel to redraw is drawn again whole, up to `consistency.maxAttempts`
  times, told what each such panel must show (`Make sure: in panel 2, …`), and the sheet with the fewest panels to
  redraw (then the fewest conflicts) is kept: a panel drawn again on its own loses what the sheet's panels agree on.
  Each shot's `shot.board` takes its panel, with its reading, as its first attempt; the identity judge and the quality
  checks read it as any drawn frame, and only a panel that fails them is drawn again on its own, with the scene
  reference, as before. A kept panel's board records `sheet` (the sheet's image, the panel's number and how many it
  had), the sheet's request, and its reading as `seen`.
- **Full-size frames.** With `settings.storyboard.sheetFullSize` (off by default: takes from these frames score 1.35 lower,
  [fp47](first-pass.md#a-scene-drawn-on-one-sheet); and it needs a gateway that
  [delivers references](first-pass.md#the-image-model-never-saw-its-references)) a panel is not the frame: each shot's
  `shot.board` draws its frame at the project's resolution from its panel (`compilePanelRenderRequest`: the panel as the
  one reference image, and a prompt that asks for the very same picture and says nothing else of the shot; the cast's
  images beside it score no better and copy it less closely, fp46). The frame goes through the same checks as any frame, and one
  that contradicts its shot is drawn again from the panel, told what to correct, never alone. The board's `sheet` records
  the panel as `drawnFrom`.
- **Failures.** A sheet that cannot be drawn or cut leaves its shots to be drawn one at a time.

`rideo_storyboard_sheets_total{outcome}` counts sheets by how they were cut (`gutters`, `cells`) or `failed`;
`rideo_storyboard_sheet_panels_total{result}` counts panels `kept`, `redrawn` alone or drawn again at full size (`full_size`).

## Video pass

In the shot pipeline (`shot.generate`), a shot whose board is **approved and current** skips the keyframe step: the
board's keyframe is the first frame (`take.request.firstFrameSource: 'storyboard'`) and its report is the keyframe
evidence. Continuous shots still start from the previous take's last frame when it is usable (R5), and from their
board otherwise. A board whose dialogue mix is current (same lines, same voice locks) gives the take its TTS audio
without speaking the lines again. With prompt version 2 the video prompt describes the frame as drawn, read once by the
vision model and kept on the board (`board.seen`, [the video reads its first frame](first-pass.md#the-video-reads-its-first-frame)).

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

The **Storyboard** view (`/p/:id/storyboard`) shows the storyboarded scenes (and the production scenes that have
frames) as rows of frame cards (image, shot
number, length, camera, description, lines, state) with approve, regenerate and move earlier/later; the header
generates the storyboard, approves every current frame, and links the shot list downloads; the **Animatic** panel
builds, plays and exports the animatic. Each row opens its scene on the [director's desk](director-desk.md#the-desk).
The Story view imports a screenplay file.

## Observability

`rideo_storyboard_frames_total{result}` counts frames by gate result; jobs carry the project and shot ids in their
logs. Errors: `board_unapprovable` (409) for approving a missing, failed, stale or outdated frame;
`validation_error` for an import that finds no scene.
