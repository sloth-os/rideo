import type { EditorJobKind, EngineState, Job } from '@rideo/shared';
import { create } from 'zustand';
import { type FfmpegStatus, ffmpeg } from './ffmpeg';

export interface BusyJob {
  jobId: string;
  kind: EditorJobKind;
  projectId: string;
  progress: Job['progress'];
  /** What times its heartbeats: a worker keeps pace in a hidden tab (docs/design/engine-performance.md). */
  ticks?: 'worker' | 'page';
}

/** The tab's editor engine, for the UI and for presence (docs/design/realtime-sync.md#presence). */
export interface EngineView {
  ffmpeg: FfmpegStatus;
  webcodecs: { video: string | null; audio: string | null } | null;
  busy: BusyJob | null;
  /** Threads of the loaded ffmpeg.wasm core (1: single-threaded; docs/design/engine-performance.md). */
  threads: number;
  /** What composites the preview and WebCodecs exports here, once known. */
  compositor: 'webgpu' | 'canvas' | null;
}

export const useEngine = create<EngineView>(() => ({
  ffmpeg: ffmpeg.status,
  webcodecs: null,
  busy: null,
  threads: ffmpeg.threads,
  compositor: null,
}));
ffmpeg.subscribe((s) => useEngine.setState({ ffmpeg: s, threads: ffmpeg.threads }));

export function enginePresence(v: EngineView): EngineState {
  return {
    ffmpeg: v.ffmpeg,
    webcodecs: v.webcodecs ?? { video: null, audio: null },
    busyJobId: v.busy?.jobId ?? null,
    threads: v.threads,
    compositor: v.compositor,
    hidden: globalThis.document?.visibilityState === 'hidden',
  };
}
