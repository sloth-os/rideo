import { GpuRenderer } from './gpu';
import { type CompositorKind, compositorChoice } from './gpu-plan';

/** The per-browser compositor preference (docs/design/engine-performance.md#webgpu-compositing). */
export const COMPOSITOR_KEY = 'rideo.compositor';

export function compositorPreference(): string | null {
  try {
    return localStorage.getItem(COMPOSITOR_KEY);
  } catch {
    return null;
  }
}

let shared: Promise<GpuRenderer | null> | null = null;

/** The tab's WebGPU renderer (one per tab) when the compositor is WebGPU here, else null. */
export async function gpuRenderer(): Promise<GpuRenderer | null> {
  const preference = compositorPreference();
  if (preference === 'canvas') return null;
  shared ??= GpuRenderer.create();
  const renderer = await shared;
  if (renderer?.lost) {
    shared = null;
    return null;
  }
  return compositorChoice(preference, !!renderer) === 'webgpu' ? renderer : null;
}

export type { CompositorKind };
