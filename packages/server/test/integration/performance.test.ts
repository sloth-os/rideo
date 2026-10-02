import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Clip, Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ff, uploadReady } from '../helpers/media';
import { type ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Performance-driven animation (docs/design/performance.md): a recorded performance acted by the cast. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => {
  await stack?.stop();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: ApiError) => `${err.status} ${err.body?.code}`,
  );

/** 3 s of a browser-like recording: VP8 and Opus in WebM, a moving pattern and a 440 Hz voice. */
async function recording(dir: string): Promise<string> {
  const out = join(dir, 'performance.webm');
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=30:duration=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:v',
    'libvpx',
    '-b:v',
    '400k',
    '-c:a',
    'libopus',
    '-shortest',
    out,
  ]);
  return out;
}

describe('performance takes', () => {
  it("acts a recorded performance on a shot with the performance model, with the performer's sound", async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, { storyboard: { enabled: false } });
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
    });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    const clip = Object.values<Clip>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0]!;
    const shot = [...clip.shots].sort((a, b) => a.index - b.index)[0]!;
    const perf = await uploadReady(stack, pid, await recording(stack.dataDir), {
      mime: 'video/webm',
      name: 'performance.webm',
      role: 'reference',
    });
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      motionReference: { resourceId: perf.id, mode: 'performance' },
    });

    // Which model acts it; none when the project turns them off
    expect(await stack.api('GET', `/projects/${pid}/performance`)).toEqual({
      model: 'mock-performance-v1',
      available: true,
    });
    await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { performance: 'off' } } });
    expect(await stack.api('GET', `/projects/${pid}/performance`)).toEqual({ model: null, available: false });
    expect(
      await code(stack.api('POST', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`)),
    ).toBe('422 performance_unavailable');
    await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { performance: 'auto' } } });

    const job = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`);
    expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
    const after = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clip.id] as Clip;
    const take = after.shots.find((s) => s.id === shot.id)!.takes.at(-1)!;
    expect(take.request).toMatchObject({
      videoModel: 'mock-performance-v1',
      motionReference: { resourceId: perf.id, mode: 'performance' },
      firstFrameSource: 'keyframe',
    });
    // the performance's length (with its sound's last frame)
    expect(take.request.durationSec).toBeCloseTo(Math.min(shot.durationSec, 3), 0);
    expect(take.request.prompt).toContain('Animate the characters of the first frame with the performance');
    // Verified like every take, and it sounds like the performance
    expect(take.consistency?.status).not.toBe('failed');
    expect(take.audio).toBeNull();
    const file = join(stack.dataDir, 'performed-take.mp4');
    await writeFile(
      file,
      Buffer.from(
        await (await fetch(`${stack.url}/api/projects/${pid}/media/${take.video!.path}`)).arrayBuffer(),
      ),
    );
    const probe = await ff.probe(file);
    expect(probe.hasAudio).toBe(true);
    expect(probe.durationSec).toBeCloseTo(Math.min(shot.durationSec, 3), 0);
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_performance_takes_total\{outcome="passed"\} 1/);

    // Agents see the model; a performance must be a video of the project
    const client = new Client({ name: 'Claude Code', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
    try {
      const r = await client.callTool({ name: 'performance_model', arguments: { projectId: pid } });
      expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({
        model: 'mock-performance-v1',
        available: true,
      });
    } finally {
      await client.close();
    }
    expect(
      await code(
        stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
          motionReference: { resourceId: 'res_000000000missing', mode: 'performance' },
        }),
      ),
    ).toMatch(/^4\d\d /);
  }, 300_000);
});
