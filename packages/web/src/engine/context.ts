import type { Job } from '@rideo/shared';

/** What an editor-job handler gets from the worker (docs/design/editor.md#editor-jobs). */
export interface EditorJobContext {
  job: Job;
  projectId: string;
  signal: AbortSignal;
  /** Progress, reported with the next heartbeat. */
  progress(done: number, total: number, message?: string): void;
  /**
   * Stages an output file on the server (kept across leases). Rendered files are passed as bytes: an unreachable
   * `Blob` keeps its memory until a garbage collection its size does not prompt (docs/design/editor.md#memory).
   */
  upload(name: string, data: Blob | Uint8Array): Promise<void>;
}

export type EditorJobHandler = (ctx: EditorJobContext) => Promise<unknown>;

/** A failure with a stable code for the job record. */
export class EditorJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EditorJobError';
  }
}
