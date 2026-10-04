import fontUrl from './fonts/DejaVuSans.ttf?url';

/** The font file, emitted with the app (and the library) next to its scripts (docs/design/subpath.md). */
export const VIDEO_FONT_URL: string = fontUrl;

/** The video text font: DejaVu Sans, bundled for drawtext (ffmpeg.wasm) and the WebCodecs compositor alike. */
export const VIDEO_FONT = 'Rideo Video Sans';

let loaded: Promise<void> | null = null;

export function ensureVideoFont(): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return Promise.resolve();
  loaded ??= (async () => {
    const face = new FontFace(VIDEO_FONT, `url(${JSON.stringify(VIDEO_FONT_URL)})`);
    document.fonts.add(await face.load());
  })().catch(() => undefined);
  return loaded;
}
