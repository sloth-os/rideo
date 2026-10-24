# Editing tools

The editor ([editor](editor.md)) gets the tools people reach for every minute in Adobe Premiere Pro and CapCut: undo and
redo, markers, snapping, dragging items between tracks, copy and paste, keyboard shortcuts, track controls and a context
menu (the **workflow**), and freeze frames, detached audio, mirroring, slide, circle and dip-to-white transitions, color
adjustments and chroma key (the **clip tools**).

The rules of the editor hold for all of them: every change is a timeline operation applied by the one shared reducer
(`applyOps`, the same from the UI, an MCP agent through `timeline_apply` and REST), and the preview, the WebCodecs
compositor (canvas and WebGPU) and the ffmpeg render plan draw the same frames from the same shared queries.

| Premiere Pro / CapCut | Rideo |
|---|---|
| Undo, redo (`Ctrl+Z`, `Ctrl+Shift+Z`) | [undo and redo](#undo-and-redo): every edit of the session, back and forth |
| Markers (`M`), go to next/previous marker | [markers](#markers) on the ruler, named and colored, a snap target |
| Snapping (`S` in Premiere, the magnet in CapCut) | [snapping](#snapping) to edit points, markers and the playhead (`N`) |
| Drag clips in time and between tracks; main track ↔ overlay | [moving items](#moving-items) |
| Copy, paste, duplicate | [copy, paste, duplicate](#copy-paste-and-duplicate) |
| J K L, ← →, ↑ ↓ edit points, Home End, `Ctrl+K` / `Ctrl+B` split | [shortcuts](#shortcuts), listed under `?` |
| Track lock, toggle output (eye), mute | [track controls](#track-controls) |
| Right-click menu on a clip | [context menu](#context-menu) |
| Frame hold / Freeze | [freeze frame](#freeze-frame) |
| Unlink / Extract audio | [detach audio](#detach-audio) |
| Horizontal / vertical flip, Mirror | [mirror](#mirror) |
| Push, slide, dip to white, iris | [transitions](#transitions) |
| Lumetri basic correction / Adjust | [color adjustments](#color-adjustments) |
| Ultra Key / Chroma key | [chroma key](#chroma-key) |

## The workflow

### Undo and redo

The editor keeps the session's **edit history** as two stacks of commit ids (`features/editor/history.ts`, pure and
tested):

- every confirmed edit pushes the commit the timeline was at before it (`commit.parents[0]` of the ops' answer) onto
  **undo** and empties **redo**;
- **Undo** pops a commit and restores `timeline.json` from it (`POST /history/restore {commit, paths:
  ["timeline.json"]}`, a new commit: history is never rewritten), pushing the commit it came from onto **redo**;
- **Redo** does the opposite.

At load the undo stack holds one entry, the parent of the last commit that changed the timeline, so the last edit can
be undone after a reload. Stacks keep the last 100 states. Undo and redo run one after the other, each on the history
the previous one left, so quick presses all count. A restore puts back the whole timeline, so changes others made
since that state go too; history keeps them. Buttons: *Undo* and *Redo* (disabled with empty stacks); keys:
`Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z` and `Ctrl+Y`.

### Markers

```ts
type Marker = { id: string; t: number; label: string; color: MarkerColor };   // `mrk_…`, timeline seconds
type MarkerColor = 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'purple';  // default orange
Timeline.markers?: Marker[];   // sorted by time, at most 1000
```

| `op` | Fields | Effect |
|---|---|---|
| `add_marker` | `marker: {id?, t, label?, color?}` | |
| `update_marker` | `markerId`, `t?`, `label?`, `color?` | |
| `remove_marker` | `markerId` | |

Markers stay where they are when items ripple, as sequence markers do in Premiere; an intro bumper
([brand kits](brand-kits.md)) moves them later with everything else. `M` adds one at the playhead and selects it; the
ruler shows each as a flag in its color (click to go there, drag to move it, snapping), with a hairline across the
lanes. The inspector edits the selected marker (label, color, *Go to*, *Delete*); `Shift+M` and `Ctrl/⌘+Shift+M` go to
the next and previous marker. On phones a Markers card lists them. Markers are not part of the NLE exports yet
([interchange](interchange.md)).

### Snapping

`snapTargets(timeline, {exclude, playhead})` (`shared/src/timeline/snap.ts`) lists where things snap: 0, the end of
the cut, every item's start and end (except the items being moved), every marker and the playhead.
`snapTime(t, targets, tolerance)` returns the nearest target within the tolerance, else `t`. While snapping is on, a
dragged edge, a dragged item (by its start or its end, whichever is nearer a target), a dragged marker and the playhead
scrubbed on the ruler snap within 8 pixels (a scrub does not snap to the playhead itself), and a vertical guide shows
the target. `N` and the magnet button toggle it;
the choice is kept in this browser (`rideo.editor.snap`).

### Moving items

Every item drags with the pointer:

| From | To | Op |
|---|---|---|
| a free track (overlay video, audio, text) | another time on it | `move {itemId, start}` |
| a free track | another track of the same kind | `move {itemId, trackId, start}` |
| an overlay track | the primary track | `move {itemId, trackId, index}` (the index the drop falls at) |
| the primary track | another place in it | `move {itemId, index}` |
| the primary track | an overlay track | `move {itemId, trackId, start}` (the primary track ripples) |

`move` gains `trackId`: the item keeps everything but its transition (an overlay has none; onto the primary track the
transition is checked again). A text item moves only between text tracks, audio between audio tracks. `Alt+←/→` nudges
a free item by a frame and moves a primary item one place earlier or later.

### Copy, paste and duplicate

| `op` | Fields | Effect |
|---|---|---|
| `duplicate` | `itemId` | a copy with a new id right after it: the next index on the primary track (without a transition), else at its end on its track |

`Ctrl/⌘+C` copies the selected item into the session's clipboard, `Ctrl/⌘+X` also removes it, and `Ctrl/⌘+V` pastes
it at the playhead as an `insert`: on its own track when it is still there (else the first track of its kind), at the
playhead's index on the primary track. `Ctrl/⌘+D` duplicates.

### Shortcuts

The keymap is a table (`features/editor/shortcuts.ts`); the same table drives the keys and the `?` dialog. Keys are
ignored while typing in a field.

| Keys | Action |
|---|---|
| `Space`, `K`, `L` | play/pause, pause, play |
| `J` | play backwards (steps of a tenth of a second) |
| `←` `→` | one frame back, forward |
| `Shift+←` `Shift+→` | one second back, forward |
| `↑` `↓` | previous, next edit point (an item's start or end on any track, a marker) |
| `Home` `End` | start, end |
| `S`, `Ctrl/⌘+K`, `Ctrl/⌘+B` | split the selected item at the playhead (without a selection: the primary item there) |
| `Delete`, `Backspace` | delete the selected item or marker |
| `Ctrl/⌘+C`, `X`, `V`, `D` | copy, cut, paste, duplicate |
| `Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z`, `Ctrl+Y` | undo, redo |
| `M`, `Shift+M`, `Ctrl/⌘+Shift+M` | add a marker, next marker, previous marker |
| `N` | snapping on/off |
| `+` `=`, `-`, `\` | zoom in, zoom out, zoom to fit |
| `Alt+←` `Alt+→` | nudge the selected item |
| `Escape` | deselect |
| `?` | the shortcuts |

### Track controls

```ts
Track.locked?: boolean;   // its items cannot change
Track.hidden?: boolean;   // video tracks: not drawn (their sound still plays), like Premiere's toggle output
```

`set_track` takes `locked` and `hidden`. Any operation that would change the items of a locked track (insert, remove,
move from or to it, trim, split, the `set_*` of an item, text updates, replace, duplicate, freeze, detach, cutting
ranges) or remove the track fails with `track "<name>" is locked`; caption styles skip locked tracks. An intro bumper
needs the primary track unlocked and moves the other tracks' items regardless, like Premiere's sync lock. A hidden
primary track draws black where its items are; hidden overlays are skipped by `activeAt`, by the render plan and so by
exports. Each lane has a header with its name and the eye (video), speaker and lock toggles; a locked lane's items are
striped and do not drag or trim, and the inspector says so and offers *Unlock* (phones have no lane headers).

### Context menu

Right-clicking an item opens a menu: *Split at playhead*, *Duplicate*, *Copy*, *Cut*, *Freeze frame* and *Detach
audio* (video items), *Mirror* (video), *Delete*; on an empty part of a lane: *Paste*, *Add marker*. Each entry shows
its shortcut. On phones the inspector has the same actions as buttons.

### The ruler

The ruler's ticks follow the zoom (1, 2, 5, 10, 30 or 60 seconds apart); dragging on it scrubs the playhead (with
snapping), and *Zoom to fit* (`\`) fits the whole cut in the lane's width.

## Clip tools

### Freeze frame

```ts
VideoItem.freeze?: { duration: number };   // 0.1–60 s: the frame at `in`, held (`out` = `in` + 0.04)
```

| `op` | Fields | Effect |
|---|---|---|
| `freeze_frame` | `itemId`, `at` (timeline seconds), `duration?` (default 2) | splits the item at `at` and puts a freeze of the frame shown there between the halves; on a free track the second half moves `duration` later |
| `set_freeze` | `itemId`, `duration` | |

A freeze item lasts `freeze.duration`, shows the frame at `in` (`sourceAtItemTime` returns `in`), is silent, and keeps
the effects, LUT, transform, mirror and key of the item it came from (not its mask or ramp). It cannot take a speed, a
ramp or a mask (a matte plays); trimming its `in` changes the frame, dragging its edges changes how long it holds, splitting it gives two
freezes. The ffmpeg chain takes one frame, the last at or before `in` as the preview's frame cursor finds it (else the
first after it), and clones it for the part of the chunk it covers (`IN` relative to the input's seek, in
microseconds):

```
[k:v]trim=start=IN-0.1:end=IN+0.2,select='lte(t\,IN+0.0001)+eq(n\,0)',reverse,trim=end_frame=1,
     setpts=PTS-STARTPTS,<fit>,<flip>,setsar=1,fps=FPS,tpad=stop_mode=clone:stop=FRAMES-1,trim=end_frame=FRAMES,
     format=yuv420p,settb=AVTB
```

NLE exports give it speed 0: OTIO a `LinearTimeWarp` with `time_scalar: 0` (read back as a freeze), FCPXML a
`timeMap` that holds, Final Cut Pro 7 XML a 0 % time remap, EDL an `M2` line at 000.0.

### Detach audio

| `op` | Fields | Effect |
|---|---|---|
| `detach_audio` | `itemId`, `trackId?` | the video item's sound becomes an audio item at the same time (same source, range, volume, fades and speech spans) on the given audio track or a new *Sound* track with the stem of the item's track; the video item is muted |

It needs a video item with sound at 1× (no ramp, no freeze, not a still). The audio item then trims, moves and fades on
its own (J and L cuts).

### Mirror

```ts
VideoItem.flip?: { x?: boolean; y?: boolean };   // x: mirror left–right, y: upside down
```

`set_flip {itemId, flip | null}`. ffmpeg adds `hflip` / `vflip` after the fit (the matte of a masked item flips with
it); the canvas mirrors the picture (the whole letterboxed frame, or the fitted picture of an overlay) and WebGPU
reverses the texture coordinates.

### Transitions

Six more transition types, all of them `xfade` transitions in ffmpeg (FFmpeg 5.1 in the browser engine):

| Type | `xfade` | The compositor, at progress `q` (0 → 1, ffmpeg's `progress` = 1 − q) |
|---|---|---|
| `crossfade` | `fade` | the incoming frame at opacity `q` |
| `wipe` | `wipeleft` | the incoming frame right of the edge, which moves leftward: columns from `trunc((1 − q)·W) + 1` |
| `dip_to_black` | `fadeblack` | both frames full (letterbox included) over black, weighted as `xfade` does (below) |
| `dip_to_white` | `fadewhite` | the same over white |
| `slide_left` | `slideleft` | `P = trunc((1 − q)·W)`: the incoming frame at `x = P`, the outgoing at `P − W` |
| `slide_right` | `slideright` | the incoming frame at `−P`, the outgoing at `W − P` |
| `slide_up` | `slideup` | `P = trunc((1 − q)·H)`: the incoming frame at `y = P`, the outgoing at `P − H` |
| `slide_down` | `slidedown` | the incoming frame at `−P`, the outgoing at `H − P` |
| `circle_open` | `circleopen` | the incoming frame inside a soft circle: weight `1 − smoothstep(0, 1, d/z + (0.5 − q)·3)`, `d` the distance to the centre, `z = hypot(W/2, H/2)` |

The dips weight the outgoing frame `a`, the incoming `b` and the color `c` exactly as `xfade` does, with `g = 1 − q`:
`a·g·s₁ + b·q·(1 − s₂) + c·(rest)`, `s₁ = smoothstep(0.8, 1, g)`, `s₂ = smoothstep(0.2, 1, g)`: the outgoing frame is
gone after a fifth of the transition and the incoming one comes up slowly, never quite through black. The canvas draws
the color, then the incoming frame at `in / (1 − out)`, then the outgoing one at `out`. ffmpeg mixes them in RGB
(`format=gbrp` before the `xfade`: in YUV, `xfade`'s black and white are 0 and 255 luma, not the RGB ones). Slides
move whole frames by whole pixels like `xfade`; the canvas draws the circle with a 16-stop radial gradient, within a
level of `xfade`'s curve. Dips and the circle are drawn per pixel from whole frames by the canvas compositor, also when
WebGPU draws the other frames; WebGPU draws wipes and slides with scissor rectangles. The sound of every transition is
the existing crossfade. NLE exports name the new types after their nearest NLE transition (OTIO and Final Cut Pro 7
XML: push or slide, dip to color, iris; EDL: a dissolve, a wipe for slides).

Before this change the preview drew wipes from the left while exports wiped leftward, and dips to black symmetrically
while `xfade` dips as above; both now draw what the export renders.

### Color adjustments

`effects` gains seven adjustments next to brightness, contrast and saturation:

| Field | Range | What |
|---|---|---|
| `exposure` | −2–2 | stops: every channel × 2^e |
| `temperature` | −1–1 | warmer (red up, blue down) or cooler |
| `tint` | −1–1 | magenta (+) or green (−) |
| `hue` | −180–180 | degrees around the color wheel (the CSS `hue-rotate` matrix) |
| `shadows` | −1–1 | lifts or crushes the dark tones |
| `highlights` | −1–1 | lifts or pulls down the bright tones |
| `vignette` | 0–1 | darkens toward the corners |

They run after the LUT and brightness/contrast/saturation, in RGB, in this order, with the arithmetic of the ffmpeg
filters that render them (`shared/src/media/color.ts` has the gain and tone tables, the hue matrix, the vignette factor
and the key alpha; the canvas and WebGPU use them; coefficients are kept to nine decimals, which the graph prints
exactly; integration tests run the filters with native ffmpeg and compare every value):

1. **Gains**, one table per channel, `k = 2^exposure`, `gR = k(1 + 0.3t)(1 + 0.1u)`, `gG = k(1 − 0.2u)`,
   `gB = k(1 − 0.3t)(1 + 0.1u)`: `trunc(v·g)` clipped to 0–255, ffmpeg `lutrgb=r='val*gR':g='val*gG':b='val*gB'`
   (`colorchannelmixer` takes gains up to 2 only).
2. **Tone**, one table for every channel: `f(v) = v + 0.6·v·(1 − v/255)·(s·(1 − v/255) + h·v/255)`, truncated and
   clipped to 0–255: ffmpeg `lutrgb` with that expression.
3. **Hue**, the CSS `hue-rotate` matrix: ffmpeg `colorchannelmixer=rr=…:bb=…`, which adds the products rounded to
   the nearest integer (`lrint`, halves to even) and clips.
4. **Vignette** with the lens angle `A = vignette·π/2`: each channel × `cos(A·d)⁴`, `d` the distance from the centre of
   the picture (whole pixels, truncated) over the centre-to-corner distance: ffmpeg `vignette=angle=A:dither=0` on
   `rgb24`. The centre is the frame's for letterboxed primary items (their bars included, as ffmpeg sees them) and the
   picture's for overlays and transformed, masked or keyed items.

ffmpeg converts to `rgb24` once for the four and back to `yuv420p` (or to `rgba` when a key follows). The canvas
applies them to the picture's pixels after the LUT; WebGPU in its shader with the same integer steps.

### Chroma key

```ts
VideoItem.key?: { color: string; similarity: number; blend: number };   // '#00ff00', 0.01–1 (0.3), 0–1 (0.1)
```

`set_key {itemId, key | null}`. The key makes the picture transparent where it is close to the key color, after every
color step: alpha =
`trunc(clamp((diff − similarity)/blend, 0, 1)·255)`, `diff = √((Δr² + Δg² + Δb²)/(3·255²))` (a hard edge when `blend` is
0), ffmpeg `format=rgba,colorkey=0xRRGGBB:S:B`. A keyed overlay shows the tracks below; a keyed primary item shows black.
An item has a key or a mask ([Remove the background](editor.md#segmentation-masks-remove-the-background)), not both.

## Surfaces

The inspector of a video item gets *Freeze frame*, *Detach audio*, *Mirror* and *Upside down* buttons, *Duplicate*,
the six transitions in the transition list, a **Freeze frame** section (how long it holds) on freezes, an **Adjust**
section (the seven sliders and *Reset*) and a **Chroma key** section (on/off, the color with green and blue presets,
similarity, blend). The lanes carry the new state: `data-locked`, `data-hidden`, `data-track-id` and `data-marker`
attributes, a ❄ on freeze items, ⇋ on mirrored ones and ⌗ on keyed ones. The toolbar has *Marker*, the snapping magnet,
zoom out, in and to fit, and the shortcuts. Agents use the same ops through `timeline_apply` ([MCP](mcp.md)). Every new
op is validated by `TimelineOpSchema` and counted in the commit message like the others.
