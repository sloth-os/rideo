import { audioSegments, referencedMedia, type Timeline, timelineDuration } from '@rideo/shared';
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  WebMOutputFormat,
} from 'mediabunny';
import { scheduleAudio } from './audio';
import type { EngineCaps } from './capabilities';
import { Compositor } from './compositor';
import { MediaPool } from './media-pool';

export interface BrowserExport {
  blob: Blob;
  filename: string;
  codec: string;
  width: number;
  height: number;
  durationSec: number;
  draft: boolean;
}

const even = (n: number) => Math.max(2, n - (n % 2));

/**
 * Renders the timeline with WebCodecs: compositor frames → CanvasSource, offline audio mixdown →
 * AudioBufferSource, muxed by mediabunny. The server applies the watermark afterwards (key stays server-side).
 */
export async function renderInBrowser(opts: {
  projectId: string;
  timeline: Timeline;
  caps: EngineCaps;
  title: string;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<BrowserExport> {
  const { timeline, caps } = opts;
  if (!caps.webcodecs || !caps.video || !caps.container)
    throw new Error('This browser cannot encode video with WebCodecs; use the server render.');
  let width = even(timeline.width);
  let height = even(timeline.height);
  // Prefer originals when this browser can decode them; otherwise render a draft from the proxies.
  let pool = new MediaPool(opts.projectId, { width, height }, true);
  let draft = false;
  for (const m of referencedMedia(timeline).filter((x) => x.mime.startsWith('video/'))) {
    const entry = await pool.get(m).catch(() => null);
    if (!entry?.video) {
      pool.dispose();
      draft = true;
      const scale = Math.min(1, 640 / width);
      width = even(Math.round(width * scale));
      height = even(Math.round(height * scale));
      pool = new MediaPool(opts.projectId, { width, height }, false);
      break;
    }
  }
  const duration = timelineDuration(timeline);
  const fps = timeline.fps;
  const total = Math.max(1, Math.round(duration * fps));
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  const target = new BufferTarget();
  const output = new Output({
    format:
      caps.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target,
  });
  const videoSource = new CanvasSource(canvas, { codec: caps.video, bitrate: QUALITY_HIGH });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const hasAudio = caps.audio !== null && audioSegments(timeline).length > 0;
  const audioSource = hasAudio
    ? new AudioBufferSource({ codec: caps.audio!, bitrate: QUALITY_MEDIUM })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);
  output.setMetadataTags({ title: opts.title, comment: 'Rendered in the browser with Rideo (WebCodecs)' });
  const compositor = new Compositor(pool, timeline);
  try {
    await output.start();
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const t = i / fps;
      await compositor.render(ctx, t, width, height, true);
      await videoSource.add(t, 1 / fps);
      if (i % 6 === 0) opts.onProgress?.(i, total + (audioSource ? Math.ceil(total / 10) : 0));
    }
    videoSource.close();
    if (audioSource) {
      const offline = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * 48_000)), 48_000);
      await scheduleAudio(offline, timeline, pool, 0, 0);
      const rendered = await offline.startRendering();
      await audioSource.add(rendered);
      audioSource.close();
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  } finally {
    compositor.dispose();
    pool.dispose();
  }
  opts.onProgress?.(total, total);
  const mime = caps.container === 'mp4' ? 'video/mp4' : 'video/webm';
  return {
    blob: new Blob([target.buffer!], { type: mime }),
    filename: `browser-export.${caps.container}`,
    codec: `${caps.video}${audioSource ? `/${caps.audio}` : ''}`,
    width,
    height,
    durationSec: duration,
    draft,
  };
}
