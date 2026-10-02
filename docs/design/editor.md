# Editor: timeline, browser media engine (ffmpeg.wasm + WebCodecs), rendering

## Timeline model

```ts
type Timeline = {
  version: 1;
  fps: number; width: number; height: number;
  tracks: Track[];            // the first video track is the primary (magnetic) one; more video tracks are overlays
};
type Track = { id: string; kind: 'video' | 'audio' | 'text'; name: string; muted?: boolean; volume?: number; items: Item[] };

type Source =
  | { type: 'take'; clipId: string; shotId: string; takeId: string; media: MediaRef }
  | { type: 'media'; media: MediaRef; resourceId?: string };

type VideoItem = {
  id: string; kind: 'video'; source: Source;
  start: number;              // timeline seconds (derived for the primary track, see below)
  in: number; out: number;    // source seconds
  speed: number;              // 0.25–4
  volume: number; muted?: boolean;             // embedded audio
  fadeIn?: number; fadeOut?: number;           // from/to black, seconds
  transitionIn?: { type: 'crossfade' | 'wipe' | 'dip_to_black'; duration: number } | null;
  effects?: { brightness?: number; contrast?: number; saturation?: number };
  label?: string;
  speech?: [number, number][];                 // speech spans in source seconds (ducking keys)
  transform?: { keyframes: Keyframe[] };       // position, scale, rotation, opacity over the item's time
  ramp?: { points: { at: number; speed: number }[] };  // a speed ramp over source seconds (replaces `speed`)
  lut?: { media: MediaRef; resourceId?: string; intensity: number };   // a .cube 3D LUT, 0–1 mixed in
  mask?: { media: MediaRef; offset: number; subject: string; invert: boolean; model: string | null };
};
type Keyframe = { t: number;                   // seconds from the item's start
                  x?: number; y?: number;      // centre of the picture, fractions of the frame (0.5, 0.5)
                  scale?: number;              // 1 = the picture fitted to the frame
                  rotation?: number;           // degrees, clockwise
                  opacity?: number };          // 0–1
type AudioItem = { id: string; kind: 'audio'; source: Source; start: number; in: number; out: number;
                   volume: number; fadeIn?: number; fadeOut?: number; speech?: [number, number][] };
// VideoItem.crop?: { focus: { t, x, y }[] }   reframed around the subject (docs/design/finishing.md)
// Tracks: { id, kind, name, muted?, volume?, role?: 'dialogue' | 'music' | 'effects', items }
// Timeline: { version, fps, width, height, tracks, mix?: { ducking: { enabled, depthDb, attackSec, releaseSec } } }
type TextItem  = { id: string; kind: 'text'; start: number; duration: number; text: string;
                   style: { preset: 'title' | 'lower_third' | 'caption' | 'label';
                            position?: 'top' | 'center' | 'bottom'; align?: 'left' | 'center' | 'right';
                            color?: string; size?: number; animate?: 'none' | 'build' | 'pop';
                            font?: { media: MediaRef; family: string };   // a brand font (docs/design/brand-kits.md)
                            box?: string | null; boxOpacity?: number };    // the box behind: a color, or none
                   words?: { from: number; to: number; start: number; end: number }[] };  // timed caption words
```

- The **primary video track** (the first video track) **is magnetic**. Items are ordered and contiguous, and
  `start` is recomputed by the reducer (`start[i+1] = end[i] − transitionIn[i+1].duration`). Reordering,
  trimming or deleting ripples automatically.
- **Overlay tracks** (more video tracks) hold B-roll, picture-in-picture and overlays. Their items are
  positioned freely, have no transitions, and are composited over the primary track in track order (the last
  track on top). On an overlay, `fadeIn`/`fadeOut` fade the item's opacity instead of fading to black.
- Item length on the timeline = `(out − in) / speed`, or the integral of `1 / speed` over the source range for a
  ramped item.
- Audio and text items are positioned freely.
- The WebCodecs compositor and the ffmpeg filtergraph read the same shared queries, so the preview and both
  render engines draw the same frames ([multitrack](#multitrack-transforms-and-keyframes)).

## Operations

Every edit, from the UI, an MCP agent (`timeline_apply`) or a job (assemble, auto edit), is a JSON
operation applied by one pure reducer: `applyOps(timeline, ops) → timeline` in
`shared/src/timeline/ops.ts`. Invalid operations throw `TimelineOpError {code, opIndex}`, and nothing is
committed.

| `op` | Fields | Effect |
|---|---|---|
| `insert` | `trackId`, `item`, `index?` | primary: insert at index (default end); other tracks: at `item.start` |
| `remove` | `itemId` | primary ripples |
| `move` | `itemId`, `index?` or `start?` | reorder the primary track, or reposition on other tracks |
| `trim` | `itemId`, `in?`, `out?` | clamp to `[0, media.durationSec]`, keep `in < out` |
| `split` | `itemId`, `at` (timeline seconds) | two items; the second gets a fresh id |
| `set_transition` | `itemId`, `transition \| null` | duration ≤ min(prev, current) length / 2 |
| `set_speed` | `itemId`, `speed` | |
| `set_volume` | `itemId`, `volume` | |
| `set_fades` | `itemId`, `fadeIn?`, `fadeOut?` | |
| `set_effects` | `itemId`, `effects` | |
| `add_text` / `update_text` | text item fields | |
| `add_track` / `remove_track` / `set_track` | track fields (`role`: the stem of an audio track or of the primary track's sound) | the primary track cannot be removed |
| `set_mix` | `ducking: {enabled?, depthDb?, attackSec?, releaseSec?}` | the music ducks under speech ([post audio](post-audio.md#ducking)) |
| `set_caption_style` | `style: {animate?, position?, size?, color?}` | every caption of the cut ([localization](localization.md#captions-and-word-timing)); `update_text` with new text drops a caption's words |
| `replace_source` | `itemId`, `source` | swap to a regenerated take, keeping in/out when possible |
| `set_output` | `fps?`, `width?`, `height?` | |
| `add_track` with `kind: "video"` | `name?` | a new overlay track above the others |
| `set_transform` | `itemId`, `transform \| null` | keyframes sorted by time, at most 100 |
| `set_ramp` | `itemId`, `ramp \| null` | 2–50 points inside `[in, out]`, speeds 0.1–8 |
| `set_lut` | `itemId`, `lut \| null` | a LUT resource ([color](#luts)) |
| `set_mask` | `itemId`, `mask \| null` | the matte of [Remove the background](#segmentation-masks-remove-the-background) |
| `remove_ranges` | `media` (a media path), `ranges[[a, b]]` (source seconds) | cuts those parts out of every primary item playing that media and ripples ([transcript editing](#transcript-editing)) |
| `add_bumper` | `position` (`intro`, `outro`), `source`, `durationSec` | a bumper at the start or end of the picture track; an intro moves every item of the other tracks later by its length ([brand kits](brand-kits.md)) |

A committed `timeline.json` change carries `meta.ops` (the op list), so history shows what was done. The
editor's undo restores `timeline.json` from the previous timeline commit
(`history_restore {paths: ["timeline.json"]}`).

The browser applies its own edits **optimistically**: the same reducer runs locally on the current
timeline, the UI updates at once, and the ops are sent to `POST /timeline/ops`. The server's result (or
the live `commit` event) is authoritative and replaces the local copy; a rejected batch rolls the local
timeline back and shows the error. Concurrent edits by agents therefore never diverge for more than one
round trip.

### Queries (shared, used by preview and render)

`timelineDuration(t)` and `activeAt(t, time)` return the video layers at a time (the primary track's one, or two
during a transition, with `alpha`/`wipe` progress, then the overlay items in track order, each with its transform
evaluated at that time), the audio segments, and the text overlays. `sourceTimeAt(item, time)` maps timeline
time to source time through the item's speed or ramp. The WebCodecs compositor and the ffmpeg render planner
both consume this output, so they agree on every frame.

### Generators

- `assembleStoryTimeline(clips, opts)`: approved clips in order, one video item per shot (the selected take),
  a 0.5 s crossfade at clip boundaries, an optional music bed (volume 0.35, 2 s fade-in, 3 s fade-out,
  repeated to cover the length), optional dialogue captions.
- `applySuggestions(source, suggestions)`: accepted suggestions over one source video. Kept segments are
  `[0, duration]` minus `cut` ranges, minus the tightened part of silences (or only `highlight` segments
  when present). Speed ranges split segments. Transitions, titles, captions, music and fades map to their
  timeline fields. Suggestion times are in source seconds and are mapped to output time.

## Multitrack, transforms and keyframes

A video item's **transform** places its picture: the centre `(x, y)` in frame fractions, `scale` relative to the
picture fitted into the frame, `rotation` in degrees and `opacity`. Keyframes are in item seconds; each property
is interpolated linearly between the keyframes that set it and held before the first and after the last
(defaults: centred, 1, 0°, 1). One keyframe is a static transform (a picture-in-picture in a corner); two or more
animate it (a push-in, a slide, a fade). The primary track's items can be transformed too (over black).

Typical uses, one click each in the inspector: **picture-in-picture** (scale 0.35, top right), **B-roll** (an
overlay item at full size over the interview), **push-in** (scale 1 → 1.15 over the item), **fade** (opacity
0 → 1 over 0.5 s).

| | ffmpeg filtergraph (per chunk) | WebCodecs compositor and preview |
|---|---|---|
| overlay item | its own input chain → `format=rgba` → transform → `overlay=x:y:eval=frame:enable='between(t,a,b)':eof_action=pass` over the composite of the tracks below | `drawImage` in track order |
| position | `x='W*X(t)-w/2'`, `y='H*Y(t)-h/2'` (piecewise-linear expressions of chunk time) | `translate` |
| scale | `scale=w='trunc(FW*S(t)/2)*2':h=-2:eval=frame` (FW = the fitted width) | the drawn size |
| rotation | `rotate=a='R(t)*PI/180':c=none:ow='hypot(iw,ih)':oh=ow` | `rotate` |
| opacity | constant: `colorchannelmixer=aa=O`; keyframed or faded: `sendcmd` (a command per frame while it changes) on a named `colorchannelmixer` | `globalAlpha` |

Expressions are written in chunk time, so an overlay that spans a chunk boundary continues exactly. Neither
engine needs anything the other lacks: both work at the output size, in the same order, from the same
interpolation (`transformAt(item, localTime)` in `shared/src/timeline/keyframes.ts`).

### Speed ramps

A **ramp** gives the speed at points of the source (`at` in source seconds, 0.1–8×, linear in between, held
outside). The item's timeline length is the integral of `1 / speed`; `sourceTimeAt` integrates it in steps of
1/240 s into a piecewise-linear time map. The ffmpeg chain replaces `setpts=(PTS-STARTPTS)/SPEED` with
`setpts='MAP(T-STARTT)/TB'`, MAP being that time map inverted (source → output) as nested `if` expressions, and
`fps=FPS` resamples. A ramped item's own sound is muted (the soundtrack plays sound at constant speeds only);
presets: *ease in* (0.5× → 2×), *ease out*, *speed up the middle* (1× → 3× → 1×).

### LUTs

Color looks are 3D LUTs in the Resolve/Adobe **`.cube`** format, uploaded as resources of kind `lut` (validated:
`LUT_3D_SIZE` 2–65, `DOMAIN_MIN`/`DOMAIN_MAX`, size³ RGB rows; `parseCube` in `shared/src/media/cube.ts`). An item's
`lut` applies before its color effects: ffmpeg `lut3d=file=…:interp=trilinear` (mixed with the original through
`blend=all_mode=normal:all_opacity=I` when `intensity < 1`); the compositor applies the same trilinear lookup to the
frame's pixels.

### Segmentation masks (Remove the background)

*Remove the background* on a video item asks a **segmentation model** of the gateway (`supports_segmentation`;
`settings.models.segment`, `auto` by default) for a **matte** of the subject (a prompt such as "the person"): a
grayscale video of the same frames, white where the subject is. The server cuts the item's source range (with a
second of margin) for the request, stores the matte as `media/masks/<name>-<hash12>.mp4`, and sets the item's
`mask` (`offset` = where the matte starts in source time) with one `set_mask` commit; the `mask.generate` job
reports progress like any generation. Rendering uses the matte as the item's alpha: ffmpeg seeks the matte with
the same `trim`/`setpts`/fit as the picture, `format=gray` (`negate` when `invert`), `alphamerge`; the compositor
copies the matte's luma into the frame's alpha. An overlay item with a mask shows the tracks below around the
subject; a primary item shows black. Outside the matte's range the item is unmasked. Without a capable model the
request fails with `segmentation_unavailable` (422).

## Transcript editing

Footage projects edit by text. The analysis transcript carries **word timings** (`transcript[].words[{text,
start, end}]` in source seconds: the speech-to-text provider's words when it returns them, otherwise spread over
the segment by length, flagged `approx`). The editor's **Transcript** panel shows the words of the cut's sources,
struck through where the cut does not play them; selecting words and pressing *Delete* (or *Cut*) sends one
`remove_ranges` op with their source ranges, which splits and ripples the primary track.

*Remove filler words* finds `um`, `uh`, `erm`, `er`, `ah`, `hmm`, `mm`, and the phrases `you know` and `I mean` when
they stand alone between pauses or punctuation (`fillerWords` in `shared/src/timeline/transcript.ts`), lists
them with a count, and removes them all in one op (ranges padded by 30 ms and merged when closer than 150 ms).

## Waveforms and filmstrips

Timeline items show their sound as a **waveform** (peaks per 10 ms, decoded with WebCodecs `AudioBufferSink` from
the original or the local proxy) and their picture as a **filmstrip** (thumbnails every few seconds at the
lane's height, `CanvasSink`); both are computed in the tab, kept per media hash for the session, and drawn for the
visible part of the lane.

## Where editing runs

Every editing operation runs **in the browser**. The server stores, versions and publishes; it never
decodes or encodes media for editing.

| Operation | Runs in | Engine |
|---|---|---|
| Timeline edits (ops, undo, assemble preview) | browser (optimistic) + server (authoritative commit) | shared reducer |
| Probe and poster of an upload | browser, before the upload | ffmpeg.wasm |
| Playback of media the browser cannot decode | browser, local proxy cached in OPFS | ffmpeg.wasm (transcode) + WebCodecs |
| Preview player | browser | WebCodecs (mediabunny) |
| Footage analysis signals (scenes, black, silence, loudness, thumbnails, speech audio) | browser | ffmpeg.wasm |
| Footage analysis AI (summary, suggestions, transcript) | server | LLM / vision / STT through the gateway proxy |
| Rendering the timeline | browser, in chunks | ffmpeg.wasm filtergraph or WebCodecs compositor; soundtrack via ffmpeg.wasm |
| Invisible watermark of the finished export | server | native ffmpeg + watermark core (the key never leaves the server) |

The server keeps native ffmpeg only for work that is not editing: the generation pipeline (judge frame
samples, continuity frames, posters of generated takes, cast sheets, brief attachment frames) and the
watermark (embedding and detection). See [generation-pipeline](generation-pipeline.md) and
[watermark](watermark.md).

Work that an agent or the WebDAV inbox starts (no browser involved) becomes an **editor job**: a job in
the `client` lane that an open studio tab of that project claims and runs. See [Editor jobs](#editor-jobs).

## Browser media engine

`packages/web/src/engine/`:

| Module | Role |
|---|---|
| `ffmpeg.ts` | One ffmpeg.wasm instance per tab (`@ffmpeg/ffmpeg` 0.12, FFmpeg 5.1 core served from our origin, loaded lazily: the multi-threaded core in a cross-origin isolated tab, [engine performance](engine-performance.md)). Runs one command at a time (queue). Inputs are `Blob`s mounted read-only with `WORKERFS` (no copy into wasm memory); outputs are read back and deleted. Log lines are captured for the shared parsers. Cancelling terminates the worker and reloads the core (≈ 1 s). |
| `media-files.ts` | Blob access to project media: files this tab uploaded are reused from memory, others are downloaded once (LRU). |
| `prepare.ts` | Probe (`ffmpeg -i` banner, parsed by `shared/media/probe.ts`) and poster for a file. |
| `codecs.ts`, `local-proxy.ts`, `proxy-plan.ts` | Whether WebCodecs decodes a media file, and the local proxies (see below). |
| `threads.ts`, `ticker.ts`, `keep-alive.ts` | Threads of the multi-threaded core's commands; heartbeats timed by a worker and a Web Lock while a job runs ([engine performance](engine-performance.md)). |
| `media-jobs.ts` | The `media.process` and `analysis.signals` editor jobs. |
| `render/` | Chunked rendering: `engine-choice.ts`, `ffmpeg-engine.ts` (chunk graph and soundtrack), `webcodecs-engine.ts` (compositor chunk), `export-job.ts` (the `export.render` editor job). The plan itself is `shared/media/render-plan.ts`. |
| `worker.ts`, `index.ts`, `state.ts` | The editor-job worker (claims, heartbeats, runs and completes the open project's editor jobs), its per-tab instance, and the engine state shown in the header and sent with presence. |
| `fonts.ts` | The bundled DejaVu Sans, used by drawtext and by the WebCodecs compositor, so titles look the same in both engines. |

ffmpeg.wasm is not used for real-time playback; the preview player (`features/editor/engine/player.ts`)
decodes with WebCodecs, fed by originals or local proxies. The core is 31 MB; it is fetched on first
use and cached by the browser (long-lived `Cache-Control`, hashed file name).

Measured single-thread throughput (headless Chromium on an 8-core ARM server): H.264 720p decode ≈ 130
fps; VP8 480p encode ≈ 50 fps; x264 `ultrafast` ≈ 39 fps at 720p and ≈ 22 fps at 1080p (`veryfast` ≈ 12 fps at
720p). A 60-minute 720p film therefore takes about 40 minutes with the ffmpeg engine, which is why
rendering also offers the hardware-accelerated WebCodecs engine and why analysis runs on a downscaled
stream.

## Media preparation (uploads)

Before a file is uploaded, the browser:

1. probes it: `ffmpeg -hide_banner -i <file>` (the command fails without an output, which is fine) and
   `parseProbe()` reads format, duration, streams, codecs, size, frame rate, sample rate, channels and
   rotation from the banner;
2. makes a poster for videos: `ffmpeg -ss <min(1, d/2)> -i <file> -frames:v 1 -vf
   scale='min(640,iw)':-2 -q:v 4 poster.jpg`.

`POST /uploads` then carries the file, the poster and the probe (`meta`). The server validates the probe
against `ProbeSchema`, stores the original and the poster, and the resource is `ready` at once. A resource
added without a probe (MCP `resource_add`, the WebDAV inbox, or a browser that could not load ffmpeg.wasm)
is created as `processing` with a `media.process` editor job.

## Playback compatibility (local proxies)

There are no server-side proxies. For each video the preview needs, the browser decides:

1. WebCodecs can decode the original codec (`VideoDecoder.isConfigSupported`, checked once per codec) →
   use the original (HTTP Range reads through mediabunny);
2. otherwise → a **local proxy**: `ffmpeg -i <original> -vf "scale=-2:'min(480,ih)'" -c:v libvpx
   -deadline realtime -cpu-used 8 -b:v 1M -g 12 -c:a libopus -b:a 64k proxy.webm`, stored in the Origin
   Private File System under `proxies/<hash>-<method>-<height>-v2.webm` (LRU, 2 GB cap) and reused across sessions.

When WebCodecs decodes the original but `<video>` cannot play it, the proxy is made with WebCodecs instead, and a
heavy original (above 2560 × 1440) previews from a 720-line editing proxy made with WebCodecs
([engine performance](engine-performance.md#local-proxies-made-with-webcodecs)).

Proxies share timestamps with the originals, so every edit applies unchanged to the originals when
rendering. `<video>` previews in the clip and export lists play the original; when it fails to load they
show the poster and build the proxy only when the user presses play. Browsers without an H.264 decoder (open-source Chromium builds,
some Linux distributions) take the proxy path; Chrome, Edge and Safari play originals directly.

## Footage analysis

`analysis.signals` (an editor job, started by *Analyze footage* or MCP `footage_analyze`) runs one
ffmpeg.wasm pass over the source video:

```
ffmpeg -i <source> -vf "scale=320:-2,blackdetect=d=0.3:pix_th=0.10,select='gt(scene\,0.3)',showinfo" \
       -af "silencedetect=noise=-35dB:d=0.6,ebur128=framelog=verbose" -f null -
```

`parseAnalysisLog()` (`shared/media/analysis.ts`) turns the log into scene cuts (showinfo `pts_time` after a
scene change), black segments, silences and integrated loudness (the last `Summary:` block; FFmpeg 5 also
prints an empty summary when the graph is reconfigured). Scenes shorter than 0.5 s merge into the previous
one. Then the browser takes one 320 px JPEG per scene (at most 12) and, when the server has speech-to-text
configured, a mono 16 kHz speech track (`-vn -ac 1 -ar 16000 -b:a 48k speech.mp3`). The results are
uploaded, and the server's `analysis.suggest` job runs the AI part: transcript (STT via the proxy), the
vision LLM's summary and suggestions from the signals and thumbnails, plus the deterministic rule-based
suggestions (`ruleSuggestions` in `shared/src/story/normalize.ts`: cut black, tighten long silences, fade
in/out), which exist even without an LLM.

## Rendering

Rendering is planned once in `packages/shared/src/media/render-plan.ts` and executed in the browser.

The inspector of a video item also offers **generative extend** (frames generated before or after the item from its
edge frame, inserted next to it; [take editing](take-editing.md#generative-extend-in-the-editor)).

### Chunks

`planChunks(timeline, {targetSec})` splits the output into windows of about `targetSec` (default 30 s):

- boundaries are frame-aligned (`round(t·fps)/fps`);
- a boundary never falls inside a transition overlap, so both sides of every `xfade` are in one chunk;
- boundaries prefer hard cuts; an item longer than the target is split inside the item (only `in`/`out`
  change).

Each chunk is rendered independently, so memory stays bounded for 40–60 minute films, progress is
exact, and a failed or interrupted render resumes at the first missing chunk.

### Video graph (per chunk)

Every video segment overlapping the chunk becomes a normalized stream (input seeking with `-ss` on each
source keeps chunks independent). A still image (a storyboard frame in the animatic,
[storyboard](storyboard.md#animatic)) is looped instead (`-loop 1 -framerate FPS -t D`) and trimmed from 0; the
WebCodecs compositor and the preview draw it as an `ImageBitmap`, and audio queries skip it:

```
[k:v]trim=start=IN:end=OUT,setpts=(PTS-STARTPTS)/SPEED,scale=W:H:force_original_aspect_ratio=decrease,
     pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=FPS,format=yuv420p,settb=AVTB,
     eq=brightness=B:contrast=C:saturation=S,fade=t=in:st=0:d=FI,fade=t=out:st=D-FO:d=FO[vk]
```

A reframed item (`item.crop`, an auto-reframed delivery, [finishing](finishing.md#auto-reframe-and-cut-downs)) is
cropped around its subject instead of letterboxed: `crop=w='min(iw,ih*A)':h='min(ih,iw/A)':x='…':y='…'` with the
focus as a piecewise-linear expression of the source time, then `scale=W:H`; the compositor and the preview draw the
same window (`cropWindow`).

Segments are chained left to right: `xfade` (`fade`, `wipeleft`, `fadeblack`) at `offset = accumulated − d`
for transitions, `concat` for cuts. A transformed, masked or LUT-graded item adds its steps to its chain (a
transformed or masked primary item is overlaid on black at the output size); overlay tracks are then composited on
the result ([multitrack](#multitrack-transforms-and-keyframes)); text comes last, on top. Every stream is on `AV_TIME_BASE` (`settb=AVTB`) because `concat`
outputs that timebase and `xfade` rejects inputs whose timebases differ. Text items overlapping the chunk
become `drawtext` (bundled DejaVu Sans, `fonts/DejaVuSans.ttf`) with `enable='between(t,a,b)'` in chunk
time; an animated caption draws one `drawtext` per word frame (`textFrames`), and `activeAt` gives the compositor and
the preview the same frames ([localization](localization.md#captions-and-word-timing)). The `label` preset is small and boxed, aligned to a corner (`align` left or right, `position` top or
bottom); the export's [disclosure label](provenance.md#disclosure-label) is such an item, added to the render
timeline by `withDisclosure()` for the whole film. The chunk ends with `fps=FPS,trim=duration=LEN`, which snaps timestamps back onto the frame grid,
so every chunk has exactly `round(LEN·FPS)` frames and the chunks join without gaps.

### Soundtrack

The audio is planned for the whole film (audio is cheap, and one continuous encode avoids AAC priming gaps
at chunk joins): item audio (when `hasAudio`, not muted, not ramped; overlay items' sound on their track's stem,
effects by default) and audio tracks,
`atrim → asetpts → atempo chain → volume → afade → adelay`, mixed per stem (dialogue, music, effects) with
`amix=normalize=0`, `apad` and trimmed to the length; the music bus is ducked under speech; the buses are summed
([post audio](post-audio.md#stems)). ffmpeg.wasm renders it losslessly (`soundtrack.flac`) and, when the export
asks for stems, each bus to `stem-<role>.flac` in the same run. The preview plays the same buses with the same
duck automation (`automateDuck`).

### Engines

| Engine | Video path | Use |
|---|---|---|
| `ffmpeg` (ffmpeg.wasm) | the chunk graph above → libx264 (`ultrafast`; CRF 18 draft / 16 standard / 14 high) in MP4 | reference output; decodes any source codec in wasm; ≈ 20–40 fps |
| `webcodecs` | the compositor (`activeAt` → frames → alpha, wipe, fades, effects, text; on WebGPU when the browser has it, else the 2D canvas, [engine performance](engine-performance.md#webgpu-compositing)) → hardware `VideoEncoder` (H.264 in MP4, else VP9/AV1/VP8 in WebM) via mediabunny | fast (GPU); needs every source decodable by WebCodecs (originals or local proxies) |
| `auto` (default) | `webcodecs` when the browser can encode video and decode every source original with WebCodecs; otherwise `ffmpeg` | |

Both engines produce video-only chunk files (`part-0001.mp4`, …) plus the soundtrack, uploaded as they
finish. Chunks are intermediates: the server's finishing pass re-encodes the final export, so they favour
speed and quality over size.

### Finishing (server)

When the last part arrives, the `export.finish` job enhances the parts when the delivery is larger or faster than
the render (a gateway model, else ffmpeg; [finishing](finishing.md#enhancement-upscale-and-frame-interpolation)),
concatenates them (concat demuxer), runs the watermark frame pipeline at the delivery's size and rate (decode →
`embedLuma` → the delivery's encoder: x264, ProRes 422 HQ, or PNG frames), normalizes the soundtrack's loudness to
the export's target ([post audio](post-audio.md#loudness)) and muxes it (AAC, or PCM for ProRes), bounded by the
film's length (`-t`, never `-shortest`), publishes the stems as signed WAVs and the thumbnails when asked, writes
provenance metadata, registers the watermark, publishes `media/exports/<exportId>-<hash12>.mp4` (`.mov`, `.tar`)
and tags the commit. MP4 encodes follow the quality presets:

| Preset | Video | Max size |
|---|---|---|
| `draft` | x264 veryfast CRF 26 | 720p |
| `standard` (default) | x264 medium CRF 20 | project size |
| `high` | x264 slow CRF 17 | project size |

## Editor jobs

An editor job is a job in the `client` lane. The server never runs it; a browser tab does.

| Kind | Params | The tab… | Result → server |
|---|---|---|---|
| `media.process` | `resourceId` | fetches the original, probes it, makes the poster | probe + poster → resource `ready` |
| `analysis.signals` | `analysisId`, `resourceId`, `speech` | runs the analysis pass, thumbnails, speech audio | signals + files → `analysis.suggest` job |
| `export.render` | `exportId`, `quality`, `engine`, `chunkSec`, `timelinePath` (the cut, the animatic or `renders/<exportId>.json`), `stems` | renders the soundtrack (and stems) and every chunk | parts + manifest → `export.finish` job |

Protocol (REST, see [api/rest.md](../api/rest.md#editor-jobs)):

1. **Claim.** A tab with a project open asks `POST /api/editor/claim {sessionId, projectId}` when it is
   idle, on every `job` event for a queued `client` job, and every 10 s. The server hands out the oldest
   queued editor job of that project, sets `status: running` and a lease (`sessionId`, `expiresAt`, 60 s).
2. **Heartbeat.** Every 10 s the tab reports progress and extends the lease. The reply tells it when the
   job was cancelled. A worker times the heartbeats and the job holds a Web Lock, so a hidden tab keeps its lease
   ([engine performance](engine-performance.md#rendering-in-a-background-tab)).
3. **Files.** Outputs are uploaded one by one (`PUT /api/editor/jobs/:jobId/files/:name`) into a staging
   folder on the server's disk (`RIDEO_DATA_DIR/staging/<jobId>/`). The job lists them in `staged`.
4. **Complete / fail.** The tab posts the result (validated per kind); the server applies it and starts the
   follow-up job. Failures are reported with a code.
5. **Recovery.** When a lease expires or the tab's live session closes, the job returns to `queued`
   (up to `maxAttempts`), keeping its staged files: the next tab resumes an export at the first missing
   part.

A tab that is running an editor job shows it in the jobs panel ("in this tab") and asks for confirmation
before it is closed. Without an open tab, editor jobs wait in `queued`; MCP results say so
(`waitingFor: "editor"`), and `ui_sessions` lists which tabs have an engine available.

## Editor UI

- Preview canvas with transport (play/pause, frame step, timecode) and a WebCodecs capability badge.
- Timeline with zoom, a ruler (click to seek), a playhead, and labelled item blocks (a ⤫ marks a
  transition) with waveforms and filmstrips. Drag to reorder the primary track, drag item edges to trim, `S` to
  split at the playhead, `Delete` to remove, arrow keys to step frames, `Space` to play; overlay video lanes above
  the primary one (*Add video track*), audio and text lanes. Edits apply locally at once (optimistic) and are
  confirmed by the server. Footage and takes go onto an overlay lane at the playhead with *Add as overlay*.
- Inspector for the selected item (in/out, speed, volume, fades, effects, transition, text and timing), with
  **Transform** (x, y, scale, rotation, opacity at the playhead: *Set keyframe*, *Remove keyframe*, the keyframe
  list, presets), **Speed ramp** (presets, off), **LUT** (a LUT resource, intensity) and **Remove the background**
  (subject, invert, remove).
- **Transcript** panel in footage projects ([transcript editing](#transcript-editing)).
- Undo restores `timeline.json` from the previous timeline commit (a new commit; history is never rewritten).
- Mix card ([post audio](post-audio.md#surfaces)): ducking on/off and depth, every audio track's stem,
  *Score the cut* (with an optional direction) and *Add sound effects*. Lanes carry `data-track-role`.
- Captions & languages card ([localization](localization.md#surfaces)): the caption style, SRT/VTT downloads,
  every language with its progress (lines, dubs, lip-synced close-ups) and actions (translate, dub, edit), and
  adding a language.
- Export dialog: the delivery preset and its options (format, size, frame rate, aspect, length, thumbnails;
  [finishing](finishing.md)), quality and engine (*Auto*, *ffmpeg.wasm*, *WebCodecs*) with the detected
  capabilities, the loudness target and *Stems*, the language (with dubbed voices) and burned-in or sidecar
  captions, chunk progress (or the subject being found for a reframe), and failures that stay visible in the dialog. The render runs in this tab; the export
  appears in Exports once the server has watermarked it.
- An engine indicator in the header shows whether ffmpeg.wasm is loaded and what this tab is working on.
- On phones the timeline collapses into a vertical list; the inspector and the Mix card sit under it.
