import type { MediaRef } from '@rideo/shared';
import { ALL_FORMATS, AudioBufferSink, CanvasSink, Input, UrlSource } from 'mediabunny';
import { mediaUrl } from '../../../lib/api';

export interface PoolEntry {
  input: Input;
  video: CanvasSink | null;
  audio: AudioBufferSink | null;
}

/**
 * One mediabunny Input per media file, reading the browser-safe proxy when there is one (VP9/Opus),
 * with pooled canvases sized for the preview/export surface.
 */
export class MediaPool {
  private readonly entries = new Map<string, Promise<PoolEntry>>();

  constructor(
    private readonly projectId: string,
    private readonly size: { width: number; height: number },
    private readonly preferOriginal = false,
  ) {}

  get(media: MediaRef): Promise<PoolEntry> {
    let p = this.entries.get(media.hash);
    if (!p) {
      p = this.open(media);
      this.entries.set(media.hash, p);
      p.catch(() => this.entries.delete(media.hash));
    }
    return p;
  }

  private async open(media: MediaRef): Promise<PoolEntry> {
    const path = !this.preferOriginal && media.proxy ? media.proxy.path : media.path;
    const input = new Input({ source: new UrlSource(mediaUrl(this.projectId, path)), formats: ALL_FORMATS });
    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    const video =
      videoTrack && (await videoTrack.canDecode())
        ? new CanvasSink(videoTrack, {
            width: this.size.width,
            height: this.size.height,
            fit: 'contain',
            poolSize: 4,
          })
        : null;
    const audio = audioTrack && (await audioTrack.canDecode()) ? new AudioBufferSink(audioTrack) : null;
    return { input, video, audio };
  }

  dispose(): void {
    for (const p of this.entries.values()) void p.then((e) => e.input.dispose()).catch(() => undefined);
    this.entries.clear();
  }
}
