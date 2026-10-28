import { describe, expect, it } from 'vitest';
import { DEFAULT_PAUSES, EndpointPauses } from '../../src/ai/pauses';
import { Metrics } from '../../src/metrics';

/** Model endpoints that keep failing are paused (docs/design/ai-gateway.md#outages). */
describe('endpoint pauses', () => {
  const setup = (baseMs = DEFAULT_PAUSES.baseMs) => {
    let now = 1_000_000;
    const metrics = new Metrics();
    const logs: string[] = [];
    const log = {
      warn: (_o: object, m: string) => logs.push(m),
      info: (_o: object, m: string) => logs.push(m),
    };
    const pauses = new EndpointPauses({ ...DEFAULT_PAUSES, baseMs }, { metrics, log, now: () => now });
    return { pauses, metrics, logs, tick: (ms: number) => (now += ms) };
  };
  const ep = 'newapi.example.org/qwen3.8-max';

  it('pauses after 6 failures in a row, for 30 s, then twice as long after each failure that follows', () => {
    const { pauses, metrics, logs, tick } = setup();
    for (let i = 0; i < 5; i++) pauses.failed(ep);
    expect(pauses.admit(ep)).toEqual({ ok: true });
    pauses.failed(ep);
    expect(pauses.admit(ep)).toEqual({
      ok: false,
      waitMs: 30_000,
      failures: 6,
      outageMs: 0,
      sparesAttempts: true,
    });
    expect(metrics.llmPaused.get({ endpoint: ep })).toBe(1);
    expect(metrics.llmPauses.get({ endpoint: ep })).toBe(1);
    expect(logs).toEqual(['LLM endpoint paused after failed calls in a row']);
    // A call that was out when the pause began does not lengthen it
    tick(10_000);
    pauses.failed(ep);
    expect(pauses.admit(ep)).toMatchObject({ ok: false, waitMs: 20_000, failures: 7 });
    // After the pause it takes calls; the next failure pauses it for 60 s, then 120 s, ... up to 5 min
    tick(20_000);
    expect(pauses.admit(ep)).toEqual({ ok: true });
    pauses.failed(ep);
    expect(pauses.admit(ep)).toMatchObject({ ok: false, waitMs: 60_000, outageMs: 30_000 });
    for (const expected of [120_000, 240_000, 300_000, 300_000]) {
      tick(1_000_000);
      pauses.failed(ep);
      expect(pauses.admit(ep)).toMatchObject({ ok: false, waitMs: expected });
    }
    expect(metrics.llmPauses.get({ endpoint: ep })).toBe(6);
    // Another endpoint is not paused
    expect(pauses.admit('newapi.example.org/qwen3.8-omni-flash')).toEqual({ ok: true });
  });

  it('ends the outage at the first answer', () => {
    const { pauses, metrics, logs, tick } = setup();
    for (let i = 0; i < 6; i++) pauses.failed(ep);
    tick(30_000);
    pauses.answered(ep);
    expect(pauses.admit(ep)).toEqual({ ok: true });
    expect(metrics.llmPaused.get({ endpoint: ep })).toBe(0);
    expect(logs.at(-1)).toBe('LLM endpoint answering again');
    // The count starts again
    for (let i = 0; i < 5; i++) pauses.failed(ep);
    expect(pauses.admit(ep)).toEqual({ ok: true });
    // An answer between failures resets it too
    pauses.answered(ep);
    pauses.failed(ep);
    expect(pauses.admit(ep)).toEqual({ ok: true });
  });

  it('spares job attempts for the first hour of an outage only, and never pauses at 0', () => {
    const { pauses, tick } = setup();
    for (let i = 0; i < 6; i++) pauses.failed(ep);
    for (let i = 0; i < 14; i++) {
      tick(300_000);
      pauses.failed(ep);
    }
    expect(pauses.admit(ep)).toMatchObject({ ok: false, outageMs: 4_200_000, sparesAttempts: false });
    const off = setup(0);
    for (let i = 0; i < 50; i++) off.pauses.failed(ep);
    expect(off.pauses.admit(ep)).toEqual({ ok: true });
    expect(off.metrics.llmPauses.get({ endpoint: ep })).toBe(0);
  });
});
