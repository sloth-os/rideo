import type { RenderChunk, Timeline } from '@rideo/shared';
import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
} from 'mediabunny';
import type { EngineCaps } from '../../features/editor/engine/capabilities';
import { Compositor } from '../../features/editor/engine/compositor';
import type { GpuRenderer } from '../../features/editor/engine/gpu';
import type { MediaPool } from '../../features/editor/engine/media-pool';

/** One chunk with the compositor (WebGPU or the canvas) → hardware VideoEncoder (docs/design/editor.md#engines). */
export async function renderChunkWebCodecs(opts: {
  timeline: Timeline;
  chunk: RenderChunk;
  size: { width: number; height: number };
  caps: EngineCaps;
  pool: MediaPool;
  /** Composites on the GPU (docs/design/engine-performance.md#webgpu-compositing); null: the canvas. */
  gpu?: GpuRenderer | null;
  signal?: AbortSignal;
  onFrame?: (frame: number) => void;
  /** What composited the chunk, once it is done. */
  onBackend?: (backend: 'webgpu' | 'canvas') => void;
}): Promise<Blob> {
  const { timeline, chunk, caps } = opts;
  const { width, height } = opts.size;
  const fps = timeline.fps;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const target = new BufferTarget();
  const mp4 = caps.container === 'mp4';
  const output = new Output({
    format: mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target,
  });
  const source = new CanvasSource(canvas, { codec: caps.video!, bitrate: QUALITY_VERY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  const compositor = new Compositor(opts.pool, timeline);
  compositor.setGpu(opts.gpu ?? null);
  try {
    await output.start();
    for (let i = 0; i < chunk.frames; i++) {
      if (opts.signal?.aborted) throw new DOMException('The operation was cancelled', 'AbortError');
      await compositor.render(ctx, chunk.start + i / fps, width, height, true);
      await source.add(i / fps, 1 / fps);
      if (i % 12 === 0) opts.onFrame?.(i);
    }
    source.close();
    await output.finalize();
    opts.onBackend?.(compositor.backend);
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  } finally {
    compositor.dispose();
  }
  return new Blob([target.buffer!], { type: mp4 ? 'video/mp4' : 'video/webm' });
}
