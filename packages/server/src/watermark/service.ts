import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLayout,
  DEFAULT_WATERMARK_PARAMS,
  DETECTION_MIN_MEAN_MARGIN,
  embedLuma,
  encodePayload,
  layoutSeedMessage,
  listDecode,
  psnr,
  WatermarkAccumulator,
  type WatermarkLayout,
  type WatermarkParams,
  watermarkIdFromBytes,
} from '@rideo/shared';
import { z } from 'zod';
import type { Ffmpeg } from '../media/ffmpeg';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { hmac, randomHex } from '../util/crypto';
import { readLumaFrames, runFramePipeline } from './pipeline';

export const ProvenanceSchema = z.object({
  id: z.string(),
  version: z.literal(1),
  payload: z.string(),
  brand: z.object({ name: z.string(), owner: z.string(), url: z.string() }),
  projectId: z.string(),
  asset: z.object({
    // `resource`: frames generated for the cut (generative extend, docs/design/take-editing.md).
    kind: z.enum(['take', 'export', 'resource']),
    id: z.string(),
    clipId: z.string().optional(),
    shotId: z.string().optional(),
  }),
  media: z.object({ path: z.string(), hash: z.string() }).nullable(),
  embed: z.object({
    width: z.number(),
    height: z.number(),
    strength: z.number(),
    pair: z.array(z.array(z.number())),
  }),
  createdAt: z.string(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export interface DetectionResult {
  found: boolean;
  id?: string;
  /** Bits corrected by CRC-aided list decoding (verified against the registry). */
  corrected?: number;
  confidence: number;
  meanMargin: number;
  framesAnalyzed: number;
  size?: { width: number; height: number };
  provenance?: Provenance | null;
  metadata: { comment?: string; copyright?: string; description?: string };
}

export const CANDIDATE_SIZES: [number, number][] = [
  [1920, 1080],
  [1280, 720],
  [854, 480],
  [640, 360],
  [1080, 1920],
  [720, 1280],
  [1024, 1024],
  [1024, 768],
  [1680, 720],
  [320, 180],
];

export interface EmbedResult {
  width: number;
  height: number;
  frames: number;
  psnr: number;
}

/** Keyed invisible watermark: embed, detect, and the provenance registry (docs/design/watermark.md). */
export class WatermarkService {
  private key!: string;
  private readonly layouts = new Map<string, WatermarkLayout>();
  readonly params: WatermarkParams;

  constructor(
    private readonly deps: {
      ff: Ffmpeg;
      storage: StorageBackend;
      layout: Layout;
      metrics: Metrics;
      dataDir: string;
      key?: string;
      oldKeys: string[];
      strength: number;
      brand: { name: string; owner: string; url: string };
      log?: { info: (o: unknown, m?: string) => void };
    },
  ) {
    this.params = { ...DEFAULT_WATERMARK_PARAMS, strength: deps.strength };
  }

  /** Uses RIDEO_WATERMARK_KEY, or a generated development key persisted in the data dir. */
  async init(): Promise<void> {
    if (this.deps.key) {
      this.key = this.deps.key;
      return;
    }
    const path = join(this.deps.dataDir, 'watermark.key');
    const existing = await readFile(path, 'utf8').catch(() => null);
    if (existing?.trim()) {
      this.key = existing.trim();
      return;
    }
    this.key = randomHex(32);
    await mkdir(this.deps.dataDir, { recursive: true });
    await writeFile(path, this.key, { mode: 0o600 });
    this.deps.log?.info(
      { path },
      'generated a development watermark key (set RIDEO_WATERMARK_KEY in production)',
    );
  }

  get brand() {
    return this.deps.brand;
  }

  layoutFor(width: number, height: number, key = this.key): WatermarkLayout {
    const k = `${key.slice(0, 8)}:${width}x${height}`;
    let l = this.layouts.get(k);
    if (!l) {
      const seed = new Uint8Array(hmac(key, layoutSeedMessage(width, height)).subarray(0, 16));
      l = createLayout(seed, width, height);
      this.layouts.set(k, l);
    }
    return l;
  }

  async allocateId(): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const id = watermarkIdFromBytes(new Uint8Array(randomBytes(6)));
      if (!(await this.deps.storage.stat(this.deps.layout.watermark(id)))) return id;
    }
    throw new Error('could not allocate a unique watermark id');
  }

  metadataArgs(id: string, title?: string): string[] {
    const { name, owner, url } = this.deps.brand;
    const year = new Date().getUTCFullYear();
    return [
      '-metadata',
      `copyright=© ${year} ${owner || name}`,
      '-metadata',
      `comment=rideo-wm:v1:${id}`,
      '-metadata',
      `description=Generated with ${name}${url ? ` · ${url}` : ''}`,
      ...(title ? ['-metadata', `title=${title}`] : []),
    ];
  }

  embedder(
    id: string,
    width: number,
    height: number,
  ): { transform: (y: Uint8Array) => void; stats: () => { psnr: number } } {
    const layout = this.layoutFor(width, height);
    const bits = encodePayload(id);
    let sse = 0;
    let frames = 0;
    return {
      transform: (y) => {
        sse += embedLuma(y, width, layout, bits, this.params).sse;
        frames++;
      },
      stats: () => ({ psnr: psnr(sse, width * height * Math.max(1, frames)) }),
    };
  }

  /** Watermarks a video file (single re-encode, audio copied) and writes container provenance metadata. */
  async embedVideo(
    input: string,
    output: string,
    opts: {
      id: string;
      title?: string;
      crf?: number;
      preset?: string;
      signal?: AbortSignal;
      onProgress?: (frames: number, total: number) => void;
    },
  ): Promise<EmbedResult> {
    const probe = await this.deps.ff.probe(input);
    if (!probe.width || !probe.height) throw new Error('input has no video stream');
    const width = probe.width - (probe.width % 2);
    const height = probe.height - (probe.height % 2);
    const fps = probe.fps && probe.fps > 0 ? probe.fps : 24;
    const total = Math.max(1, Math.round(probe.durationSec * fps));
    const embed = this.embedder(opts.id, width, height);
    const { frames } = await runFramePipeline({
      ff: this.deps.ff,
      width,
      height,
      decodeArgs: [
        '-i',
        input,
        '-map',
        '0:v:0',
        '-vf',
        `fps=${fps},crop=${width}:${height}:0:0,format=yuv420p`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-',
      ],
      encodeArgs: [
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-s',
        `${width}x${height}`,
        '-r',
        String(fps),
        '-i',
        '-',
        // Bounded by the length, not `-shortest`: that ends the file when the sound runs out first and drops the
        // frames still in x264's lookahead.
        ...(probe.hasAudio
          ? ['-i', input, '-map', '0:v', '-map', '1:a:0', '-c:a', 'copy', '-t', String(total / fps)]
          : ['-map', '0:v']),
        '-c:v',
        'libx264',
        '-preset',
        opts.preset ?? 'medium',
        '-crf',
        String(opts.crf ?? 18),
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        ...this.metadataArgs(opts.id, opts.title),
        output,
      ],
      transform: embed.transform,
      signal: opts.signal,
      onProgress: (n) => opts.onProgress?.(n, total),
    });
    this.deps.metrics.watermark.inc({ op: 'embed' });
    return { width, height, frames, psnr: embed.stats().psnr };
  }

  async register(
    record: Omit<Provenance, 'version' | 'payload' | 'brand' | 'createdAt'> & { createdAt?: string },
  ): Promise<Provenance> {
    const bits = encodePayload(record.id);
    let hex = '';
    for (let i = 0; i < 64; i += 4)
      hex += ((bits[i]! << 3) | (bits[i + 1]! << 2) | (bits[i + 2]! << 1) | bits[i + 3]!).toString(16);
    const full: Provenance = {
      ...record,
      version: 1,
      payload: hex,
      brand: this.deps.brand,
      createdAt: record.createdAt ?? new Date().toISOString(),
    };
    await this.deps.storage.write(this.deps.layout.watermark(record.id), JSON.stringify(full, null, 2), {
      contentType: 'application/json',
    });
    return full;
  }

  async lookup(id: string): Promise<Provenance | null> {
    const buf = await this.deps.storage.read(this.deps.layout.watermark(id)).catch(() => null);
    if (!buf) return null;
    const parsed = ProvenanceSchema.safeParse(JSON.parse(buf.toString()));
    return parsed.success ? parsed.data : null;
  }

  /** Blind detection: native size first, then candidate embedding sizes; current and retired keys. */
  async detectVideo(
    input: string,
    opts: { maxFrames?: number; signal?: AbortSignal } = {},
  ): Promise<DetectionResult> {
    const probe = await this.deps.ff.probe(input);
    const metadata = {
      comment: probe.tags.comment,
      copyright: probe.tags.copyright,
      description: probe.tags.description,
    };
    if (!probe.width || !probe.height)
      return { found: false, confidence: 0, meanMargin: 0, framesAnalyzed: 0, metadata };
    const maxFrames = opts.maxFrames ?? 48;
    const fps = probe.fps ?? 24;
    const totalFrames = Math.max(1, Math.round((probe.durationSec || 1) * fps));
    const step = Math.max(1, Math.floor(totalFrames / maxFrames));
    const native: [number, number] = [probe.width - (probe.width % 2), probe.height - (probe.height % 2)];
    const hinted = /rideo-wm:v1:(wm_[0-9a-f]{12})/.exec(probe.tags.comment ?? '')?.[1];
    const hintedRecord = hinted ? await this.lookup(hinted) : null;
    const sizes: [number, number][] = [native];
    if (hintedRecord) sizes.push([hintedRecord.embed.width, hintedRecord.embed.height]);
    for (const s of CANDIDATE_SIZES) if (Math.abs(s[0] / s[1] - native[0] / native[1]) < 0.02) sizes.push(s);
    const unique = sizes.filter((s, i) => sizes.findIndex((x) => x[0] === s[0] && x[1] === s[1]) === i);
    let best = { meanMargin: 0, frames: 0 };
    for (const key of [this.key, ...this.deps.oldKeys]) {
      for (const [w, h] of unique) {
        const acc = new WatermarkAccumulator(this.layoutFor(w, h, key), this.params);
        const frames = await readLumaFrames({
          ff: this.deps.ff,
          width: w,
          height: h,
          decodeArgs: [
            '-i',
            input,
            '-map',
            '0:v:0',
            '-vf',
            `select='not(mod(n\\,${step}))',scale=${w}:${h}:flags=bicubic,format=yuv420p`,
            '-frames:v',
            String(maxFrames),
            '-f',
            'rawvideo',
            '-pix_fmt',
            'yuv420p',
            '-',
          ],
          onFrame: (y) => acc.addFrame(y, w),
          signal: opts.signal,
        });
        const r = acc.result();
        if (r.meanMargin > best.meanMargin) best = { meanMargin: r.meanMargin, frames };
        const hit = (id: string, corrected: number, provenance: Provenance | null): DetectionResult => {
          this.deps.metrics.watermark.inc({ op: 'detect', result: 'found' });
          return {
            found: true,
            id,
            ...(corrected ? { corrected } : {}),
            confidence: Math.min(1, r.meanMargin / 6),
            meanMargin: r.meanMargin,
            framesAnalyzed: frames,
            size: { width: w, height: h },
            provenance,
            metadata,
          };
        };
        if (r.detected) return hit(r.id, 0, await this.lookup(r.id));
        if (r.meanMargin >= DETECTION_MIN_MEAN_MARGIN) {
          // A marked video whose CRC failed on a few weak bits: accept only registry-verified corrections.
          for (const c of listDecode(r.bits, r.margins).slice(0, 64)) {
            const provenance = await this.lookup(c.id);
            if (provenance) return hit(c.id, c.flips, provenance);
          }
        }
      }
    }
    this.deps.metrics.watermark.inc({ op: 'detect', result: 'not_found' });
    return {
      found: false,
      confidence: 0,
      meanMargin: best.meanMargin,
      framesAnalyzed: best.frames,
      metadata,
    };
  }
}
