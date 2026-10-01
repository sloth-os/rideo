# Finishing and deliverables

An export is a **delivery**: a preset (or explicit options) decides the container and codecs, the size and frame
rate, the aspect ratio, the length, the loudness, the captions and what comes with the film (stems, subtitles,
thumbnails). The tab renders the picture as before; the server finishes it: enhancement (upscale, frame
interpolation) through gateway models, the watermark, the encode to the delivery format, Content Credentials and
the extras.

## Delivery presets

| Preset | Format | Size | Aspect | Loudness | Captions | Extras |
|---|---|---|---|---|---|---|
| `web` (default) | MP4 (H.264, AAC 192 kb/s) | project | source | streaming | burned in | – |
| `youtube` | MP4 (H.264 high profile, AAC 320 kb/s) | UHD (2160p) | source | streaming | SRT/VTT sidecars | thumbnails |
| `broadcast` | ProRes 422 HQ in MOV, PCM 24-bit | HD (1080p) | source | broadcast (EBU R128) | sidecars | stems |
| `vertical` | MP4 | HD (1080×1920) | 9:16, auto-reframed | streaming | burned in | thumbnails, cut down to 60 s |
| `square` | MP4 | HD (1080×1080) | 1:1, auto-reframed | streaming | burned in | thumbnails, cut down to 60 s |
| `master_prores` | ProRes 422 HQ in MOV, PCM 24-bit | project | source | off | sidecars | stems |
| `master_frames` | PNG sequence + WAV in a TAR | project | source | off | sidecars | stems |

`DELIVERY_PRESETS` (shared) is the table; `resolveDelivery(settings, input)` applies the preset and then every
explicit option (`format`, `resolution`, `fps`, `aspect`, `maxDurationSec`, `thumbnails`, `loudness`, `captions`,
`stems`). Sizes: `project` keeps the cut's size; `hd` and `uhd` give the **short side** 1080 or 2160 px in the
delivery's aspect (16:9 UHD = 3840×2160, 9:16 HD = 1080×1920). `draft` quality caps the delivery at 720 px on the
long side of 16:9 output, as before. The export records the resolved delivery
(`export.delivery = {preset, format, width, height, fps, aspect, maxDurationSec, enhance}`).

## Enhancement: upscale and frame interpolation

When the delivery is larger than the rendered picture (**upscale**) or faster than the cut's frame rate
(**interpolation**, e.g. 24 → 48 or 60 fps), `export.finish` enhances the rendered parts before watermarking:

1. **A gateway model** when one is available: `settings.models.enhance` (`auto` picks the first model of
   `GET /v1/models/limits` with `supports_upscale`, and with `supports_frame_interpolation` and `max_fps ≥ fps`
   when interpolating; `off` never uses a model). Each part is one request through `@sloth-os/mm-gateway-js`:
   the part as a `reference_video`, `dimensions` and `fps` as asked.
2. **ffmpeg** otherwise: `scale` with Lanczos and the `framerate` filter (blended frames). The export says which
   (`delivery.enhance = {upscale: "model" | "ffmpeg" | null, interpolate: …, model}`), and its Content
   Credentials add a `c2pa.edited` action per model enhancement (trained algorithmic media, the operation and
   the model).

A smaller delivery is a plain downscale.

## Formats

| Format | Picture | Sound | File | Content Credentials |
|---|---|---|---|---|
| `mp4` | H.264 (CRF by quality; YouTube: high profile) | AAC 192 kb/s (YouTube 320 kb/s) | `.mp4` | signed |
| `prores` | ProRes 422 HQ, 10-bit 4:2:2 (`prores_ks`) | PCM 24-bit 48 kHz | `.mov` | signed (`video/quicktime`) |
| `frames` | PNG per frame, `frame-000001.png` … | `soundtrack.wav` (24-bit) | `.tar` (with the subtitles) | none: an archive has no manifest; every frame carries the watermark |

The watermark is embedded at the delivery size, after enhancement, in every format.

## Auto-reframe and cut-downs

An aspect other than `source` reframes the cut:

1. **Focus.** Each take of the cut gets a focus track: the vision LLM task `reframe.focus` looks at three frames
   of the take (15%, 50%, 85%) with the shot's description and returns where the main subject is (`x`, `y` in
   0–1). The track is stored on the take (`take.focus`), so every later cut-down reuses it. Items that are not
   takes are centred.
2. **Crop.** The render timeline (`renders/<exportId>.json`) has the delivery's aspect, and every video item a
   `crop` that follows its focus: the largest window of the aspect inside the source, centred on the focus,
   clamped to the frame, moving linearly between focus points. The chunk graph crops with
   `crop=w:h:x='…':y='…'` (an expression of the source time) before scaling; the WebCodecs compositor and the
   preview draw the same window (`cropWindow`).
3. **Cut-down.** `maxDurationSec` keeps the cut up to that length: the last item is trimmed to it with a 1 s fade
   to black, music and effects fade out with it, later items, captions and dialogue are dropped.

Preparing the focus is a job (`export.prepare`, lane `llm`); the export stays `queued` until its render timeline is
written, then the tab renders it like any other.

## Thumbnails

With `thumbnails`, six candidate frames are taken from the finished film (the middle of its longest items, then
frames spread evenly over the picture), the
vision LLM task `thumbnail.pick` ranks them (a clear subject, faces, contrast, no motion blur), and the best three
are published as JPEGs (long side 1280 px, the delivery's aspect), each signed as a frame of the export
(`c2pa.opened` with the export as parent, `c2pa.edited`). `export.thumbnails` lists them.

## Surfaces

`POST /api/projects/:id/exports` (and MCP `export_render`) take `preset`, `format`, `resolution` (`project`, `hd`,
`uhd`), `fps`, `aspect` (`source`, `9:16`, `1:1`), `maxDurationSec` and `thumbnails`, next to the existing options.
The export dialog chooses a preset and shows its options to adjust; export cards show the format, size, frame rate,
aspect and enhancement, the thumbnails and the master's download.

Logs carry `projectId`, `jobId` and `exportId`; `rideo_finishing_total{op, outcome}` counts enhancement parts
(`op` = `upscale_model`, `upscale_ffmpeg`, `interpolate_model`, `interpolate_ffmpeg`), focus tracks and thumbnails.

## Mock gateway

`mock-enhance-v1` (`supports_upscale`, `supports_frame_interpolation`, `max_fps: 60`) scales its reference video to
the asked `dimensions` and converts it to the asked `fps`. `reframe.focus` answers the saturation-weighted centre of
each frame (the mock's characters are its most saturated pixels); `thumbnail.pick` ranks frames by saturation.
