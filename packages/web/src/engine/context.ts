import type { Job } from '@rideo/shared';

/** What an editor-job handler gets from the worker (docs/design/editor.md#editor-jobs). */
export interface EditorJobContext {
  job: Job;
  projectId: string;
  signal: AbortSignal;
  /** Progress, reported with the next heartbeat. */
  progress(done: number, total: number, message?: string): void;
  /** Stages an output file on the server (kept across leases). */
  upload(name: string, data: Blob): Promise<void>;
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
