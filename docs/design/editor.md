# Editor: timeline, WebCodecs preview and export, server render

## Timeline model

```ts
type Timeline = {
  version: 1;
  fps: number; width: number; height: number;
  tracks: Track[];            // exactly one video track (role "primary"); any number of audio and text tracks
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
};
type AudioItem = { id: string; kind: 'audio'; source: Source; start: number; in: number; out: number;
                   volume: number; fadeIn?: number; fadeOut?: number };
type TextItem  = { id: string; kind: 'text'; start: number; duration: number; text: string;
                   style: { preset: 'title' | 'lower_third' | 'caption'; position?: 'top' | 'center' | 'bottom';
                            color?: string; size?: number } };
```

- The **primary video track is magnetic**. Items are ordered and contiguous, and `start` is recomputed by
  the reducer (`start[i+1] = end[i] − transitionIn[i+1].duration`). Reordering, trimming or deleting ripples
  automatically.
- Item length on the timeline = `(out − in) / speed`.
- Audio and text items are positioned freely.
- One video track keeps the browser preview and the server render WYSIWYG-identical (see the non-goals in
  the architecture doc).

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
| `add_track` / `remove_track` / `set_track` | track fields | the primary track cannot be removed |
| `replace_source` | `itemId`, `source` | swap to a regenerated take, keeping in/out when possible |
| `set_output` | `fps?`, `width?`, `height?` | |

A committed `timeline.json` change carries `meta.ops` (the op list), so history shows what was done. The
editor's undo restores `timeline.json` from the previous timeline commit
(`history_restore {paths: ["timeline.json"]}`).

### Queries (shared, used by preview and render)

`timelineDuration(t)` and `activeAt(t, time)` return the video layers at a time (one, or two during a
transition, with `alpha`/`wipe` progress), the audio segments, and the text overlays. The browser
compositor and the server render planner both consume this output, so they agree on every frame.

### Generators

- `assembleStoryTimeline(clips, opts)`: approved clips in order, one video item per shot (the selected take),
  a 0.5 s crossfade at clip boundaries, an optional music bed (volume 0.35, 2 s fade-in, 3 s fade-out,
  repeated to cover the length), optional dialogue captions.
- `applySuggestions(source, suggestions)`: accepted suggestions over one source video. Kept segments are
  `[0, duration]` minus `cut` ranges, minus the tightened part of silences (or only `highlight` segments
  when present). Speed ranges split segments. Transitions, titles, captions, music and fades map to their
  timeline fields. Suggestion times are in source seconds and are mapped to output time.

## Proxy media

Chromium builds without proprietary codecs (including Playwright's) and some Linux browsers cannot decode
H.264 or AAC. The server therefore creates a **browser-safe proxy** for every video, the standard NLE
proxy workflow:

```
ffmpeg -i in -vf "scale='min(640,iw)':-2" -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1 \
       -crf 38 -b:v 0 -g <2·fps> -c:a libopus -b:a 64k proxy.webm
ffmpeg -ss <mid> -i in -frames:v 1 -vf scale=480:-2 poster.jpg
```

Proxies share timestamps with the originals, so edits made on proxies apply unchanged to the originals in
the server render.

## Browser engine (WebCodecs via mediabunny)

`packages/web/src/features/editor/engine/`:

| Module | Role |
|---|---|
| `media-pool.ts` | One mediabunny `Input(UrlSource(proxyUrl))` per media hash, with a `CanvasSink` (preview size, `fit: contain`, pooled canvases) and an `AudioBufferSink`. Lazy and reference-counted. |
| `compositor.ts` | `render(ctx, time)`: `activeAt` → frames → draw with alpha (crossfade), clip rect (wipe), black fades; effects via `ctx.filter`; text presets. |
| `player.ts` | Playback clocked by `AudioContext.currentTime`. Per-item `canvases()` iterators give sequential decode, `getCanvas()` handles scrubbing, and audio buffers are scheduled on the audio graph with gain automation. |
| `exporter.ts` | Offline render: fixed-step frames to an `OffscreenCanvas` → `CanvasSource`; audio mixdown in an `OfflineAudioContext` → `AudioBufferSource`; `Output(Mp4OutputFormat)` → `BufferTarget`. |
| `capabilities.ts` | `VideoDecoder` presence and encodable codecs (`getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'])`, `getFirstEncodableAudioCodec(['aac', 'opus'])`). |

When WebCodecs is missing, the preview falls back to `<video>` elements per item, with a banner, and
browser export is disabled (server render remains).

Browser export decodes originals when the browser can (`canDecode`). Otherwise it uses proxies and labels
the result *draft*. The file is uploaded to `POST /api/projects/:id/exports/upload`. The server then runs the
watermark finishing pass (the key never leaves the server) and publishes the export.

## Server render (ffmpeg)

`server/src/media/render.ts` turns the timeline into one ffmpeg invocation. Every video item becomes a
normalized stream:

```
[k:v]trim=start=IN:end=OUT,setpts=(PTS-STARTPTS)/SPEED,scale=W:H:force_original_aspect_ratio=decrease,
     pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=FPS,format=yuv420p,eq=brightness=B:contrast=C:saturation=S,
     fade=t=in:st=0:d=FI,fade=t=out:st=D-FO:d=FO[vk]
```

Items are then chained left to right: `xfade` (`fade`, `wipeleft`, `fadeblack`) at
`offset = accumulated − d` for transitions, `concat` for cuts. Text items become `drawtext` with
`enable='between(t,a,b)'`. Audio comes from item audio (when `hasAudio`, not muted) and audio tracks:
`atrim → asetpts → atempo chain → volume → afade → adelay`, then `amix=normalize=0`, then `apad` and trim to
the length (`anullsrc` when silent).

Video is rendered to raw frames and piped through the watermark `FramePipeline` (single final encode).
Audio is rendered to AAC in parallel, and the two are muxed with `+faststart`. Quality presets:

| Preset | Video | Max size |
|---|---|---|
| `draft` | x264 veryfast CRF 26 | 720p |
| `standard` (default) | x264 medium CRF 20 | project size |
| `high` | x264 slow CRF 17 | project size |

Progress is reported from frames through the pipeline divided by expected frames.

## Editor UI

- Preview canvas with transport (play/pause, frame step, timecode) and a WebCodecs capability badge.
- Timeline with zoom, a playhead, and item blocks (poster thumbnails, consistency badge for takes).
  Drag to reorder the primary track, drag edges to trim, `S` to split at the playhead, `Delete` to remove,
  a transition picker between items, and text and audio lanes.
- Inspector for the selected item (in/out, speed, volume, fades, effects, transition).
- Export dialog: *Render on server* (recommended for long movies) or *Render in browser (WebCodecs)*.
- On phones the timeline collapses into a vertical list with trim steppers under the preview.
