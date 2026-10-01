import type { MediaRef } from '@rideo/shared';
import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  CanvasSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  UrlSource,
} from 'mediabunny';
import { localProxy } from '../../../engine/local-proxy';
import { mediaUrl } from '../../../lib/api';

export interface PoolEntry {
  input: Input;
  video: CanvasSink | null;
  audio: AudioBufferSink | null;
  /** Reading a local proxy (the original is not decodable with WebCodecs here). */
  proxied: boolean;
}

async function tracksOf(input: Input): Promise<[InputVideoTrack | null, InputAudioTrack | null]> {
  return Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
}

async function decodable([video, audio]: [InputVideoTrack | null, InputAudioTrack | null]): Promise<boolean> {
  if (video && !(await video.canDecode())) return false;
  if (audio && !(await audio.canDecode())) return false;
  return true;
}

/**
 * One mediabunny Input per media file with pooled canvases sized for the preview/export surface. Originals are
 * read over HTTP ranges when WebCodecs decodes them; otherwise a local proxy is built with ffmpeg.wasm
 * (docs/design/editor.md#playback-compatibility-local-proxies).
 */
export class MediaPool {
  private readonly entries = new Map<string, Promise<PoolEntry>>();
  private readonly stills = new Map<string, Promise<ImageBitmap>>();

  constructor(
    private readonly projectId: string,
    private readonly size: { width: number; height: number },
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
    let input: Input = new Input({
      source: new UrlSource(mediaUrl(this.projectId, media.path)),
      formats: ALL_FORMATS,
    });
    let tracks = await tracksOf(input);
    let proxied = false;
    if (!(await decodable(tracks))) {
      input.dispose();
      input = new Input({
        source: new BlobSource(await localProxy(this.projectId, media)),
        formats: ALL_FORMATS,
      });
      tracks = await tracksOf(input);
      proxied = true;
    }
    const [videoTrack, audioTrack] = tracks;
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
    return { input, video, audio, proxied };
  }

  /** A still image item (storyboard frames in the animatic, docs/design/storyboard.md#animatic). */
  image(media: MediaRef): Promise<ImageBitmap> {
    let p = this.stills.get(media.hash);
    if (!p) {
      p = fetch(mediaUrl(this.projectId, media.path))
        .then((res) => {
          if (!res.ok) throw new Error(`could not load ${media.path}: ${res.status}`);
          return res.blob();
        })
        .then((blob) => createImageBitmap(blob));
      this.stills.set(media.hash, p);
      p.catch(() => this.stills.delete(media.hash));
    }
    return p;
  }

  dispose(): void {
    for (const p of this.entries.values()) void p.then((e) => e.input.dispose()).catch(() => undefined);
    this.entries.clear();
    for (const p of this.stills.values()) void p.then((b) => b.close()).catch(() => undefined);
    this.stills.clear();
  }
}
