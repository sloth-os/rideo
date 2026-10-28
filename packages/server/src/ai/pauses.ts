import type { Metrics } from '../metrics';

/**
 * Model endpoints that keep failing are paused (docs/design/ai-gateway.md#outages): after `failures` calls in a row
 * turned away for load, timed out or cut off, no call goes to the endpoint until the pause ends. Then it takes calls
 * again: the first answer ends the outage, the first failure pauses it again for twice as long.
 */
export interface PausePolicy {
  /** Failures in a row that pause an endpoint. */
  failures: number;
  /** The first pause (0: never pause); it doubles after every failure that follows a pause, up to `maxMs`. */
  baseMs: number;
  maxMs: number;
  /** Pauses in a row for longer than this no longer spare a job's attempts: a dead endpoint still fails its jobs. */
  outageMaxMs: number;
}

export const DEFAULT_PAUSES: PausePolicy = {
  failures: 6,
  baseMs: 30_000,
  maxMs: 300_000,
  outageMaxMs: 3_600_000,
};

interface Outage {
  /** Failures in a row. */
  failures: number;
  /** When the current pause ends (0: not paused yet). */
  until: number;
  /** The length of the last pause. */
  pauseMs: number;
  /** When the first pause of this outage began. */
  since: number;
}

/** Whether a call may go to an endpoint, and if not, for how long it is paused. */
export type Admission =
  | { ok: true }
  | {
      ok: false;
      /** Until the pause ends. */
      waitMs: number;
      failures: number;
      /** Since the outage's first pause. */
      outageMs: number;
      /** The outage is still young enough to spare a job's attempts. */
      sparesAttempts: boolean;
    };

export class EndpointPauses {
  private readonly outages = new Map<string, Outage>();

  constructor(
    private readonly policy: PausePolicy = DEFAULT_PAUSES,
    private readonly deps: {
      metrics?: Metrics;
      log?: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Asks to call `endpoint` now. */
  admit(endpoint: string): Admission {
    const o = this.outages.get(endpoint);
    const now = this.now();
    if (!o || now >= o.until) return { ok: true };
    const outageMs = now - o.since;
    return {
      ok: false,
      waitMs: o.until - now,
      failures: o.failures,
      outageMs,
      sparesAttempts: outageMs < this.policy.outageMaxMs,
    };
  }

  /** The endpoint answered (anything but a turn-away, even a `400`): the outage, if any, is over. */
  answered(endpoint: string): void {
    const o = this.outages.get(endpoint);
    if (!o) return;
    this.outages.delete(endpoint);
    if (!o.until) return;
    this.deps.metrics?.llmPaused.set({ endpoint }, 0);
    this.deps.log?.info(
      { endpoint, failures: o.failures, outageSec: Math.round((this.now() - o.since) / 1000) },
      'LLM endpoint answering again',
    );
  }

  /** A call was turned away for load, timed out or was cut off. */
  failed(endpoint: string): void {
    if (this.policy.baseMs <= 0) return;
    const now = this.now();
    let o = this.outages.get(endpoint);
    if (!o) {
      o = { failures: 0, until: 0, pauseMs: 0, since: 0 };
      this.outages.set(endpoint, o);
    }
    o.failures++;
    // A call that was already out when the pause began does not lengthen it
    if (now < o.until) return;
    if (o.until) o.pauseMs = Math.min(this.policy.maxMs, o.pauseMs * 2);
    else if (o.failures >= this.policy.failures) {
      o.pauseMs = this.policy.baseMs;
      o.since = now;
    } else return;
    o.until = now + o.pauseMs;
    this.deps.metrics?.llmPaused.set({ endpoint }, 1);
    this.deps.metrics?.llmPauses.inc({ endpoint });
    this.deps.log?.warn(
      { endpoint, failures: o.failures, pauseSec: Math.round(o.pauseMs / 1000) },
      'LLM endpoint paused after failed calls in a row',
    );
  }
}
