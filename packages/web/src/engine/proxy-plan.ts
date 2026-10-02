/**
 * Which local proxy a media file needs and how it is made (docs/design/engine-performance.md#local-proxies-made-with-webcodecs):
 * with the hardware codecs (WebCodecs) whenever they decode the original, with ffmpeg.wasm otherwise.
 */

export type ProxyMethod = 'webcodecs' | 'ffmpeg';

/** Originals heavier than this get an editing proxy in the preview. */
export const HEAVY_PIXELS = 2560 * 1440;

export interface ProxyNeed {
  /** WebCodecs decodes every stream of the original. */
  decodes: boolean;
  /** `<video>` plays the original (only asked for playback proxies). */
  plays: boolean;
  width?: number;
  height?: number;
  /** `playback`: something must play it; `editing`: the preview of a heavy original. */
  purpose: 'playback' | 'editing';
}

export function proxyPlan(need: ProxyNeed): { method: ProxyMethod; height: number } | null {
  if (need.purpose === 'editing') {
    // an original WebCodecs cannot decode already plays from its playback proxy
    const heavy = (need.width ?? 0) * (need.height ?? 0) > HEAVY_PIXELS;
    return heavy && need.decodes ? { method: 'webcodecs', height: 720 } : null;
  }
  if (need.decodes && need.plays) return null;
  const height = Math.min(480, need.height ?? 480);
  return { method: need.decodes ? 'webcodecs' : 'ffmpeg', height: Math.max(2, Math.round(height / 2) * 2) };
}

/** A proxy's file name in OPFS: the original's hash, how and how big. */
export function proxyName(hash: string, plan: { method: ProxyMethod; height: number }): string {
  return `${hash}-${plan.method}-${plan.height}-v2.webm`;
}
