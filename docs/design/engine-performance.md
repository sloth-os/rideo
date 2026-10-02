# Editor engine performance

The studio edits and renders in the browser ([editor](editor.md#where-editing-runs)). Four things make that engine
faster and sturdier: ffmpeg.wasm on every core, compositing on the GPU, renders that keep going in a background tab,
and local proxies made by the hardware codecs.

## Cross-origin isolation and multi-threaded ffmpeg.wasm

Threads in WebAssembly need `SharedArrayBuffer`, which browsers give only to **cross-origin isolated** pages. The server
sends, with every file of the studio (pages, scripts, workers, wasm) and the Vite dev server likewise:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Everything the studio loads comes from its own origin (the API, media, fonts, the ffmpeg cores), so nothing else
changes. `RIDEO_CROSS_ORIGIN_ISOLATION` chooses `require-corp` (default; Chrome, Edge, Firefox and Safari),
`credentialless` (Chrome and Firefox, for deployments that show cross-origin images) or `off`.

A tab that is cross-origin isolated loads the **multi-threaded core** (`@ffmpeg/core-mt`: the same FFmpeg 5.1 build
with pthreads and a pool of 32 threads); any other tab the single-threaded one. Commands are given threads so the pool
is never exhausted (a command asking for more threads than the pool has would hang):

| | Threads |
|---|---|
| encoders and filters (`-threads`, `-filter_complex_threads` before the output) | `min(8, navigator.hardwareConcurrency)` |
| each input's decoder (`-threads` before its `-i`) | 2, or 1 when a command has more than 6 inputs |

The engine status in the header (its tooltip) and the presence the tab sends say how many threads the core runs
(`engine.threads`, 1 for the single-threaded core).

## WebGPU compositing

The compositor ([rendering](editor.md#engines)) has two backends with the same picture:

- **WebGPU** (`features/editor/engine/gpu.ts`): every frame is a texture (`copyExternalImageToTexture`); each layer is
  one draw of a textured quad placed by its fitted rectangle, crop window and transform (computed on the CPU as an
  affine map), with its colour effects in the shader (brightness, contrast and saturation, as the canvas filters),
  its LUT as a 3D texture (`rgba16float`, trilinear, mixed by intensity), its matte's luma as alpha (inverted when
  asked), its opacity, dim and wipe (a scissor rectangle), blended with premultiplied alpha over black. Titles are
  drawn with the canvas path on a transparent layer, composited last.
- **2D canvas**: the existing path; LUTs and mattes go through `getImageData` on the CPU.

`auto` takes WebGPU when the browser has a WebGPU adapter; a per-browser preference (`localStorage`
`rideo.compositor`: `auto`, `webgpu`, `canvas`) can force either. The preview and the WebCodecs export use it, and the
export records which compositor drew it (`result.compositor`). A device lost or a failed pipeline falls back to the
canvas for the rest of the session.

## Rendering in a background tab

Browsers slow a hidden page down: timers fire at most once a second, and after five minutes once a minute; animation
frames stop; some freeze hidden tabs. An editor job keeps going:

- **Heartbeats from a worker.** A dedicated worker sends the job's heartbeats itself, on its own timer (timers in
  workers are not throttled like a hidden page's) and with its own requests, so neither a hidden page nor a main
  thread that is busy for a long while (a slow GPU readback, a long synchronous step) lets the lease (60 s) expire.
  The page tells it the latest progress and hears the replies: a cancellation or a lost lease stops the job.
- **A Web Lock** (`rideo-editor-job`) is held while a job runs: browsers do not freeze or discard tabs that hold one.
  On a phone, a screen wake lock keeps the device awake while the tab is visible and rendering.
- **No timers in the render loop**: chunks render on WebCodecs and ffmpeg.wasm callbacks only.
- **Back in the foreground**, the tab claims the next job at once; if a browser suspended it anyway (iOS), the lease
  expires and the next tab resumes from the first chunk not uploaded ([editor jobs](editor.md#editor-jobs)).

The tab's presence says when it is hidden (`engine.hidden`), so agents (`ui_sessions`) and other tabs see where a
job is running.

## Local proxies made with WebCodecs

A local proxy ([playback compatibility](editor.md#playback-compatibility-local-proxies)) is made with the hardware
codecs when it can be (mediabunny's `Conversion`: WebCodecs decode, scale, VP9 or VP8 at most 480 lines, Opus), and with
ffmpeg.wasm only when WebCodecs cannot decode the original:

| The original | Proxy |
|---|---|
| decodable by WebCodecs, playable by `<video>` | none (the original plays) |
| decodable by WebCodecs, not by `<video>` (H.264 in MKV or AVI, HEVC in some browsers) | WebCodecs |
| heavier than 2560 × 1440, for the preview (an editing proxy, 720 lines) | WebCodecs |
| not decodable by WebCodecs (ProRes, DNxHD) | ffmpeg.wasm |

Proxies keep the originals' timestamps; exports always read the originals. They are cached in OPFS as
`proxies/<hash>-<method>-v2.webm`.
