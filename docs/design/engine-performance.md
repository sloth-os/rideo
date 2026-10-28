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
| the encoder (`-threads` before the output) | `min(8, navigator.hardwareConcurrency)` |
| each input's decoder (`-threads` before its `-i`) | 2, or 1 when a command has more than 6 inputs |
| the filter graph (`-filter_complex_threads` before the output) | as many as the encoder's, as far as the command fits the pool |
| each input's reader (`-thread_queue_size` before its `-i`) | a thread per input when a command has several, as far as the command fits the pool; otherwise `-thread_queue_size 0` reads every input on ffmpeg's main thread |

A command uses an input thread per input (when it has several: FFmpeg 5.1 reads each input on a thread of its own
unless its `-thread_queue_size` is 0), its decoders' threads (none for a decoder at one thread, which decodes on the
main thread), the filter graph's workers and as many again for every scaler, and the encoder's threads with its
lookahead. Every scaler means each `scale` and each format conversion ffmpeg inserts: FFmpeg 5.1 gives every scaler its
own pool of the graph's threads (`vf_scale`), and a graph with ten of them at four threads already needs 30 more.
`withThreads` estimates the scalers from the graph (`scale`, `format`, two per `xfade`, `overlay`, `alphamerge`, one
for the output) and lowers the filter graph's threads first, then turns the input threads off, then lowers the
decoders' and the encoder's, until the command fits 30 of the 32 threads. Commands with many inputs need the input
threads off: the soundtrack opens every audio segment of the cut as an input, 118 for a ten-minute film of
five-second shots, and a chunk opens every item it shows.

The engine status in the header (its tooltip) and the presence the tab sends say how many threads the core runs
(`engine.threads`, 1 for the single-threaded core).

## WebGPU compositing

The compositor ([rendering](editor.md#engines)) has two backends with the same picture:

- **WebGPU** (`features/editor/engine/gpu.ts`): every frame is a texture (`copyExternalImageToTexture`); each layer is
  one draw of a textured quad placed by its fitted rectangle, crop window and transform (computed on the CPU as an
  affine map), mirrored by reversed texture coordinates, with its colour effects in the shader (brightness, contrast
  and saturation, as the canvas filters), its LUT as a 3D texture (`rgba16float`, trilinear, mixed by intensity), the
  RGB adjustments in the ffmpeg chain's integer steps and the chroma key
  ([editing tools](editing-tools.md#color-adjustments)), its matte's luma as alpha (inverted when asked), its opacity,
  dim, wipe and slide (scissor rectangles), blended with premultiplied alpha over black. Titles are drawn with the
  canvas path on a transparent layer, composited last. Frames inside a dip or a circle transition are drawn by the
  canvas, which mixes whole frames per pixel ([transitions](editing-tools.md#transitions)).
- **2D canvas**: the existing path; LUTs, adjustments, keys and mattes go through `getImageData` on the CPU.

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
  The page tells it the latest progress and hears the replies: a cancellation or a lost lease stops the job. One
  heartbeat request is in flight at a time (a stuck one is not joined by more), and it is given up after three
  periods so the next one can go.
- **Heartbeats on the live channel.** The page also sends each heartbeat as a `job-heartbeat` message on the live
  WebSocket, which has a connection of its own: when the tab's HTTP/2 connection is clogged (hundreds of slow media
  downloads leave no room for anything else on it), the lease still holds.
- **A Web Lock** (`rideo-editor-job`) is held while a job runs: browsers do not freeze or discard tabs that hold one.
  On a phone, a screen wake lock keeps the device awake while the tab is visible and rendering.
- **No timers in the render loop**: chunks render on WebCodecs and ffmpeg.wasm callbacks only.
- **Back in the foreground**, the tab claims the next job at once; if a browser suspended it anyway (iOS), the lease
  expires and the next tab resumes from the first chunk not uploaded ([editor jobs](editor.md#editor-jobs)).

The tab's presence says when it is hidden (`engine.hidden`), so agents (`ui_sessions`) and other tabs see where a
job is running.

## Media requests

The editor reads media over HTTP ranges (mediabunny's `UrlSource`: open-ended ranges, two per file). A tab that opened
every clip of a long cut at once would put hundreds of slow downloads on its one HTTP/2 connection to the studio, and
on the storage behind it: nothing else on that connection (API calls, job heartbeats) would get through until they
finish. So:

| Who | Rule |
|---|---|
| Timeline lanes (waveforms, filmstrips) | Load an item's media when its block first comes on screen; at most 2 requests at once for the whole tab. |
| The preview (and the animatic) | At most 3 requests at once for the whole tab. |
| Exports | Read their inputs one after another. |

A request holds its slot until its body ends, fails or is cancelled (`engine/media-fetch.ts`). Five in all: over
HTTP/1.1, where a browser opens six connections to a host, one stays free for the API, heartbeats and an export's
inputs.

**Bounded ranges.** mediabunny asks for open-ended ranges (`bytes=N-`) and cancels once it has what it needs, but the
studio and the WebDAV server behind it start sending the rest of the file. The editor's fetch closes each such range
at 4 MB (`bytes=N-(N+4 MiB-1)`, `cappedRanges`); mediabunny asks again from where an answer stopped when it needs more
(a server may cap ranges), and learns the file's size from `Content-Range`. So storage reads follow what is decoded.

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
