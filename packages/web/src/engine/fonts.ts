/** The video text font: DejaVu Sans, bundled for drawtext (ffmpeg.wasm) and the WebCodecs compositor alike. */
export const VIDEO_FONT = 'Rideo Video Sans';

let loaded: Promise<void> | null = null;

export function ensureVideoFont(): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return Promise.resolve();
  loaded ??= (async () => {
    const face = new FontFace(VIDEO_FONT, 'url(/fonts/DejaVuSans.ttf)');
    document.fonts.add(await face.load());
  })().catch(() => undefined);
  return loaded;
}
