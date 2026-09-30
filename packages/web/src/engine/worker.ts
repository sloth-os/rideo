import type { EditorJobKind, Job } from '@rideo/shared';
import { ApiError } from '../lib/api';
import { type EditorJobContext, EditorJobError, type EditorJobHandler } from './context';
import type { BusyJob } from './state';

export interface EditorApi {
  editorClaim(sessionId: string, projectId: string): Promise<{ job: Job | null }>;
  editorHeartbeat(
    jobId: string,
    sessionId: string,
    progress?: Job['progress'],
  ): Promise<{ cancelled: boolean; leaseExpiresAt: string | null }>;
  editorUpload(jobId: string, sessionId: string, name: string, data: Blob): Promise<unknown>;
  editorComplete(jobId: string, sessionId: string, result: unknown): Promise<unknown>;
  editorFail(jobId: string, sessionId: string, error: { code: string; message: string }): Promise<unknown>;
}

export interface EditorWorkerOptions {
  api: EditorApi;
  handlers: Record<EditorJobKind, EditorJobHandler>;
  pollMs?: number;
  heartbeatMs?: number;
  /** Minimum interval between progress heartbeats. */
  progressMs?: number;
  onChange?: (busy: BusyJob | null) => void;
}

const abortError = () => new DOMException('The operation was cancelled', 'AbortError');

/**
 * The tab's editor-job worker (docs/design/editor.md#editor-jobs): while a project is open it claims that
 * project's editor jobs one at a time, runs them with the engine, heartbeats on a timer (and with progress),
 * stages outputs and completes them. A cancelled job or a lost lease stops the run without reporting it.
 */
export class EditorWorker {
  private projectId: string | null = null;
  private sessionOf: () => string | null = () => null;
  private current: { job: Job; controller: AbortController; progress: Job['progress'] } | null = null;
  private claiming = false;
  private retries = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: EditorWorkerOptions) {}

  /** Where the live session id comes from (the tab's live client). */
  setSession(source: () => string | null): void {
    this.sessionOf = source;
  }

  /** The project this tab works for (null: stop claiming; a running job continues). */
  setProject(projectId: string | null): void {
    this.projectId = projectId;
    if (projectId && !this.timer)
      this.timer = setInterval(() => void this.poke(), this.opts.pollMs ?? 10_000);
    if (!projectId && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.poke();
  }

  get busy(): BusyJob | null {
    const c = this.current;
    return c
      ? {
          jobId: c.job.id,
          kind: c.job.kind as EditorJobKind,
          projectId: c.job.projectId,
          progress: c.progress,
        }
      : null;
  }

  private emit(): void {
    this.opts.onChange?.(this.busy);
  }

  /** Claims the next job when idle (called on job events, on reconnect and by the poll timer). */
  async poke(): Promise<void> {
    if (this.claiming || this.current || !this.projectId) return;
    const sessionId = this.sessionOf();
    if (!sessionId) return;
    this.claiming = true;
    let job: Job | null = null;
    try {
      job = (await this.opts.api.editorClaim(sessionId, this.projectId)).job;
      this.retries = 0;
    } catch (err) {
      // The claim can overtake the live subscription (HTTP vs WebSocket): retry shortly.
      if (err instanceof ApiError && err.code === 'conflict' && this.retries++ < 5)
        setTimeout(() => void this.poke(), 300 * this.retries);
    } finally {
      this.claiming = false;
    }
    if (job) await this.run(job, sessionId);
  }

  private async run(job: Job, sessionId: string): Promise<void> {
    const handler = this.opts.handlers[job.kind as EditorJobKind];
    const controller = new AbortController();
    const state = { job, controller, progress: job.progress };
    this.current = state;
    this.emit();
    let lost = false;
    let lastSent = 0;
    const beat = async (withProgress: boolean) => {
      try {
        const r = await this.opts.api.editorHeartbeat(
          job.id,
          sessionId,
          withProgress ? state.progress : undefined,
        );
        if (r.cancelled) controller.abort('cancelled');
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'lease_lost' || err.status === 404)) {
          lost = true;
          controller.abort('lease lost');
        }
      }
    };
    const timer = setInterval(() => void beat(true), this.opts.heartbeatMs ?? 10_000);
    const ctx: EditorJobContext = {
      job,
      projectId: job.projectId,
      signal: controller.signal,
      progress: (done, total, message) => {
        state.progress = { done, total, ...(message ? { message } : {}) };
        this.emit();
        const now = Date.now();
        if (now - lastSent >= (this.opts.progressMs ?? 1000)) {
          lastSent = now;
          void beat(true);
        }
      },
      upload: async (name, data) => {
        if (controller.signal.aborted) throw abortError();
        await this.opts.api.editorUpload(job.id, sessionId, name, data);
        if (!job.staged.includes(name)) job.staged.push(name);
      },
    };
    try {
      if (!handler) throw new EditorJobError('unsupported_job', `this tab cannot run ${job.kind}`);
      const result = await handler(ctx);
      if (controller.signal.aborted) throw abortError();
      await this.opts.api.editorComplete(job.id, sessionId, result);
    } catch (err) {
      if (!controller.signal.aborted && !lost) {
        const code = err instanceof EditorJobError ? err.code : 'editor_error';
        const message = err instanceof Error ? err.message : String(err);
        await this.opts.api
          .editorFail(job.id, sessionId, { code, message: message.slice(0, 2000) })
          .catch(() => undefined);
      }
    } finally {
      clearInterval(timer);
      this.current = null;
      this.emit();
      void this.poke();
    }
  }

  /** Aborts the running job locally (the server requeues it when the tab's session closes). */
  abort(): void {
    this.current?.controller.abort('stopped');
  }
}
