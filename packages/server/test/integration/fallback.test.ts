import { startMockGateway } from '@rideo/mock-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from '../helpers/stack';

/** A fallback endpoint per family of calls (docs/design/ai-gateway.md#outages) on the mock gateway. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    gw: await startMockGateway({ latencyMs: 20 }),
    env: {
      RIDEO_LLM_FALLBACK_PROXY_DOMAIN: 'https://fallback.example/v1',
      RIDEO_LLM_FALLBACK_MODEL: 'mock-fallback',
    },
  });
}, 60_000);
afterAll(async () => {
  await stack?.stop();
  await stack?.gw.close();
});

async function metric(name: string, ...labels: string[]): Promise<number> {
  const text = await (await fetch(`${stack.url}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && labels.every((x) => l.includes(x)));
  return line ? Number(line.split(' ').at(-1)) : 0;
}

describe('a fallback endpoint', () => {
  it('writes the screenplay on the fallback while the text model turns every call away', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Fallback',
      brief: { prompt: 'a keeper of letters' },
    });
    const before = stack.gw.counters.proxyCalls['fallback.example'] ?? 0;
    // Every call the text model gets in one run is turned away
    stack.gw.overloadChat(4);
    const job = await stack.api<{ id: string }>('POST', `/projects/${p.id}/screenplay/generate`, {});
    const done = await stack.waitJob(p.id, job.id, 60_000);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect((stack.gw.counters.proxyCalls['fallback.example'] ?? 0) - before).toBe(1);
    expect(await metric('rideo_llm_fallbacks_total', 'task="screenplay.generate"')).toBe(1);
    expect((await stack.api<any>('GET', `/projects/${p.id}/state`)).docs.screenplay.title).toBeTruthy();
    // The settings show the fallback's card, resolved
    const settings = await stack.api<any>('GET', '/settings');
    expect(settings.endpoints.llmFallback).toMatchObject({ model: 'mock-fallback' });
    expect(settings.endpoints.visionFallback).toMatchObject({ model: 'mock-fallback' });
  });
});
