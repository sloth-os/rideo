import type { EditorJobKind, EngineState, Job } from '@rideo/shared';
import { create } from 'zustand';
import { type FfmpegStatus, ffmpeg } from './ffmpeg';

export interface BusyJob {
  jobId: string;
  kind: EditorJobKind;
  projectId: string;
  progress: Job['progress'];
}

/** The tab's editor engine, for the UI and for presence (docs/design/realtime-sync.md#presence). */
export interface EngineView {
  ffmpeg: FfmpegStatus;
  webcodecs: { video: string | null; audio: string | null } | null;
  busy: BusyJob | null;
}

export const useEngine = create<EngineView>(() => ({ ffmpeg: ffmpeg.status, webcodecs: null, busy: null }));
ffmpeg.subscribe((s) => useEngine.setState({ ffmpeg: s }));

export function enginePresence(v: EngineView): EngineState {
  return {
    ffmpeg: v.ffmpeg,
    webcodecs: v.webcodecs ?? { video: null, audio: null },
    busyJobId: v.busy?.jobId ?? null,
  };
}
