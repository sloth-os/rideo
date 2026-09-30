# Invisible watermark

Every video Rideo produces (each generated take and each export) carries brand and provenance information
in three layers:

| Layer | Survives | Purpose |
|---|---|---|
| **Invisible keyed watermark** in the luma DCT domain | re-encoding (H.264/VP9 at normal quality), trimming, container changes, metadata stripping, format conversion, rescaling back to a known size | proves origin; recovers the provenance record |
| Container metadata (`copyright`, `comment=rideo-wm:v1:<id>`, `description`) | remux only | fast hint, human-readable |
| Provenance registry (`/rideo/watermarks/<id>.json` on WebDAV) | – | maps the 48-bit id to brand, owner, project, asset, media hash |

## Payload

64 bits = **48-bit watermark id** (random, collision-checked against the registry) + **CRC-16/CCITT-FALSE**
over the 6 id bytes. Ids are shown as `wm_<12 hex>`.

## Keyed layout

For a frame of `W×H`, the luma plane is split into `B = ⌊W/8⌋·⌊H/8⌋` blocks of 8×8.

1. `seed = HMAC-SHA256(RIDEO_WATERMARK_KEY, "rideo-wm-v1:" + W + "x" + H)`. The first 16 bytes seed
   `xoshiro128**`.
2. A Fisher–Yates permutation `π` of the block indices is drawn from the PRNG, then one chip
   `c_j ∈ {+1, −1}` per position.
3. Position `j` (block `π[j]`) carries payload bit `j mod 64`, whitened by its chip. Each bit therefore
   gets `⌊B/64⌋` blocks per frame, scattered pseudo-randomly: 225 at 720p, 56 at 360p.
4. Every frame uses the same layout, so any excerpt carries the full payload.

Without the key an attacker does not know which blocks, which chips or which bit mapping are used.

## Embedding (per block)

Let `A = C(u₁,v₁)` and `B = C(u₂,v₂)` be a pair of mid-low-frequency coefficients of the orthonormal 8×8
DCT-II (default pair `(2,1)/(1,2)`). The symbol for position `j` is `s = bit ⊕ (c_j < 0)`.

- Target: `d = |A| − |B| ≥ +T_blk` for `s = 1`, `d ≤ −T_blk` for `s = 0`.
- Perceptual masking: `T_blk = T · clamp(σ_blk / 12, 0.5, 2.0)`, where `σ_blk` is the block's luma standard
  deviation. Textured blocks get more energy and flat blocks less. The default `T` is set in
  `RIDEO_WATERMARK_STRENGTH`.
- If the target is not met, the gap is split between the two magnitudes (`|A| += g/2`, `|B| −= g/2`, with
  `|B|` floored at 0), signs are preserved, and each change is capped at `3·T_blk`. A block that cannot be
  fixed within the cap just becomes a weak wrong vote.
- Only two coefficients change, so the update is applied directly in the pixel domain as
  `x += ΔA·φ(u₁,v₁) + ΔB·φ(u₂,v₂)` with precomputed basis images `φ`. No full IDCT is needed. Values are then
  rounded and clamped to `[0,255]`.

Cost is about 350 multiply-adds per block (two projections, variance, two basis updates), about 5 ms per
720p frame in V8. Chroma is untouched, and PSNR stays above 45 dB at the default strength (asserted in
tests).

## Extraction

For each sampled frame (up to `N = 48`, spread across the video) and each position `j`:
`soft_j = c_j · clamp(|A| − |B|, −3T, 3T)` is accumulated into `S[bit(j)]`, and `Σ soft²` is tracked per bit.

- Each bit is `S_k > 0`.
- Per-bit margin `m_k = |S_k| / sqrt(Σ soft_k²)`. It is about `|N(0,1)|` on unmarked content and large on
  marked content.
- **Detected** iff the CRC matches **and** the mean margin is at least 2.5. The CRC alone gives a 2⁻¹⁶
  false-positive rate, and the margin test pushes it far lower. The reported `confidence` is
  `min(1, meanMargin / 6)`.
- Resolution: extraction first runs at the native size. If nothing is found, it rescales the frames (ffmpeg
  `scale`) to each candidate embedding size (the registry's known sizes plus 1920×1080, 1280×720,
  854×480, 640×360, 1080×1920, 720×1280, 1024×1024) and tries again.

## Pipelines

**Server (authoritative).** `FramePipeline` decodes to raw `yuv420p` over a pipe
(`ffmpeg -i in -map 0:v:0 -fps_mode cfr -r <fps> -f rawvideo -pix_fmt yuv420p -`), applies `embedLuma()`
to each Y plane, and pipes the frames into the encoder:

```
ffmpeg -f rawvideo -pix_fmt yuv420p -s WxH -r <fps> -i - -i in -map 0:v -map 1:a? \
       -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a copy \
       -metadata copyright="© 2026 <owner>" -metadata comment="rideo-wm:v1:<id>" -movflags +faststart out.mp4
```

Backpressure is respected on both pipes. Server exports render the timeline straight into this pipeline, so
the final movie is encoded only once.

**Browser exports.** The key never leaves the server. A WebCodecs-rendered export is uploaded, and the
server runs the same finishing pass (decode → embed → H.264 encode → register) before the export becomes
downloadable.

## Registry record

```json
{
  "id": "wm_3f2a9c01be77", "version": 1, "payload": "3f2a9c01be77c4d1",
  "brand": { "name": "Rideo Studio", "owner": "Acme Films", "url": "https://acme.example" },
  "projectId": "prj_…", "asset": { "kind": "take", "id": "tk_…", "clipId": "clp_…", "shotId": "sht_…" },
  "media": { "path": "media/takes/c0-s1-9ab3c1d2e4f5.mp4", "hash": "…" },
  "embed": { "width": 1280, "height": 720, "strength": 10, "pair": [[2,1],[1,2]] },
  "createdAt": "2026-09-30T10:00:00.000Z"
}
```

## Detection surfaces

- `POST /api/watermark/detect` (multipart `file`, or JSON `{uri}` or `{projectId, mediaPath}`) →
  `{found, id?, confidence, provenance?, metadata}`.
- MCP `watermark_detect`.
- The **Verify** page in the UI (drag a video in to see the brand, project, asset and creation time).

## Limits (documented, tested where noted)

| Attack | Result |
|---|---|
| H.264 CRF ≤ 28 re-encode | detected (tested) |
| VP9 re-encode at proxy quality | detected (tested) |
| Trim to a 2 s excerpt | detected (tested) |
| Metadata strip (`-map_metadata -1`) | detected (tested) |
| Downscale then upscale to the original size | detected (tested) |
| Cropping, rotation, heavy blur, very low bitrates, collusion or averaging across many marked copies | not guaranteed |
