import type { MediaRef, RenderEngine, RenderEngineChoice } from '@rideo/shared';
import type { EngineCaps } from '../../features/editor/engine/capabilities';
import { EditorJobError } from '../context';

/**
 * Which engine renders an export (docs/design/editor.md#engines): `auto` takes WebCodecs when the browser can
 * encode video and decode every source original with WebCodecs; otherwise the ffmpeg.wasm filtergraph.
 */
export async function chooseEngine(
  choice: RenderEngineChoice,
  caps: EngineCaps,
  sources: MediaRef[],
  canDecode: (m: MediaRef) => Promise<boolean>,
): Promise<RenderEngine> {
  const webcodecs = caps.webcodecs && !!caps.video && !!caps.container;
  if (choice === 'ffmpeg') return 'ffmpeg';
  if (choice === 'webcodecs') {
    if (!webcodecs)
      throw new EditorJobError('webcodecs_unavailable', 'this browser cannot encode video with WebCodecs');
    return 'webcodecs';
  }
  if (!webcodecs) return 'ffmpeg';
  for (const m of sources) if (m.mime.startsWith('video/') && !(await canDecode(m))) return 'ffmpeg';
  return 'webcodecs';
}

/** Part file names carry the engine, so a resumed render never mixes formats. */
export function partName(index: number, engine: RenderEngine, ext: string): string {
  return `part-${String(index + 1).padStart(4, '0')}.${engine}.${ext}`;
}
