import { type CubeLut, type MediaRef, parseCube } from '@rideo/shared';
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
import { editingProxy, playbackProxy } from '../../../engine/local-proxy';
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
 * read over HTTP ranges when WebCodecs decodes them; otherwise a local proxy is built
 * (docs/design/editor.md#playback-compatibility-local-proxies). A preview pool also reads heavy originals from an
 * editing proxy once it is built (docs/design/engine-performance.md#local-proxies-made-with-webcodecs).
 */
export class MediaPool {
  private readonly entries = new Map<string, Promise<PoolEntry>>();
  private readonly stills = new Map<string, Promise<ImageBitmap>>();
  private readonly luts = new Map<string, Promise<CubeLut>>();
  private readonly fonts = new Map<string, Promise<void>>();
  /** Entries replaced by an editing proxy: frames being read may still come from them. */
  private readonly retired: Promise<PoolEntry>[] = [];
  private disposed = false;

  constructor(
    private readonly projectId: string,
    private readonly size: { width: number; height: number },
    private readonly opts: { editingProxies?: boolean } = {},
  ) {}

  get(media: MediaRef): Promise<PoolEntry> {
    let p = this.entries.get(media.hash);
    if (!p) {
      p = this.open(media);
      this.entries.set(media.hash, p);
      p.catch(() => this.entries.delete(media.hash));
      if (this.opts.editingProxies) void this.lighten(media, p);
    }
    return p;
  }

  /** A heavy original is read from its editing proxy once it is built (the next reads of it). */
  private async lighten(media: MediaRef, original: Promise<PoolEntry>): Promise<void> {
    const entry = await original.catch(() => null);
    if (!entry || entry.proxied) return;
    const light = await editingProxy(this.projectId, media).catch((err) => {
      console.warn('editing proxy failed; previewing the original', err);
      return null;
    });
    if (!light || this.disposed || this.entries.get(media.hash) !== original) return;
    const next = this.open(media, light);
    await next
      .catch(() => null)
      .then((e) => {
        if (!e || this.disposed || this.entries.get(media.hash) !== original) return;
        this.retired.push(original);
        this.entries.set(media.hash, next);
      });
  }

  private async open(media: MediaRef, proxy?: Blob): Promise<PoolEntry> {
    let input: Input = new Input({
      source: proxy ? new BlobSource(proxy) : new UrlSource(mediaUrl(this.projectId, media.path)),
      formats: ALL_FORMATS,
    });
    let tracks = await tracksOf(input);
    let proxied = !!proxy;
    if (!(await decodable(tracks))) {
      input.dispose();
      input = new Input({
        source: new BlobSource(await playbackProxy(this.projectId, media)),
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

  /** A brand font as a FontFace named `family` (docs/design/brand-kits.md); failures fall back to the video font. */
  font(media: MediaRef, family: string): Promise<void> {
    let p = this.fonts.get(media.hash);
    if (!p) {
      p = new FontFace(family, `url(${mediaUrl(this.projectId, media.path)})`)
        .load()
        .then((face) => {
          (globalThis.document?.fonts ?? (globalThis as unknown as { fonts?: FontFaceSet }).fonts)?.add(face);
        })
        .catch(() => undefined);
      this.fonts.set(media.hash, p);
    }
    return p;
  }

  /** A `.cube` LUT, parsed once (docs/design/editor.md#luts). */
  lut(media: MediaRef): Promise<CubeLut> {
    let p = this.luts.get(media.hash);
    if (!p) {
      p = fetch(mediaUrl(this.projectId, media.path))
        .then((res) => {
          if (!res.ok) throw new Error(`could not load ${media.path}: ${res.status}`);
          return res.text();
        })
        .then(parseCube);
      this.luts.set(media.hash, p);
      p.catch(() => this.luts.delete(media.hash));
    }
    return p;
  }

  dispose(): void {
    this.disposed = true;
    for (const p of [...this.entries.values(), ...this.retired])
      void p.then((e) => e.input.dispose()).catch(() => undefined);
    this.entries.clear();
    this.retired.length = 0;
    for (const p of this.stills.values()) void p.then((b) => b.close()).catch(() => undefined);
    this.stills.clear();
  }
}
