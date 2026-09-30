import { api } from '../lib/api';
import { useEngine } from './state';
import { EditorWorker } from './worker';

/**
 * The tab's editor-job worker (one per tab; wired to the live session by LiveBridge). Handlers and the
 * WebCodecs probe load on first use so the engine (mediabunny, ffmpeg.wasm glue) stays out of the main bundle.
 */
export const editorWorker = new EditorWorker({
  api,
  handlers: {
    'media.process': async (ctx) => (await import('./media-jobs')).mediaProcessJob(ctx),
    'analysis.signals': async (ctx) => (await import('./media-jobs')).analysisSignalsJob(ctx),
    'export.render': async (ctx) => (await import('./render/export-job')).exportRenderJob(ctx),
  },
  onChange: (busy) => useEngine.setState({ busy }),
});

/** Records what this browser can encode (presence, export dialog). */
export function detectEngineCaps(): void {
  void import('../features/editor/engine/capabilities')
    .then(({ detectCaps }) => detectCaps(1280, 720))
    .then((c) => useEngine.setState({ webcodecs: { video: c.video, audio: c.audio } }))
    .catch(() => undefined);
}

export { useEngine } from './state';
