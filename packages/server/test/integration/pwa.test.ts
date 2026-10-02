import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Clip, Inbox, Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptPush } from '../../src/push/webpush';
import { type ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** The installable app (docs/design/pwa.md): the Inbox and notifications on people's devices. */
let stack: Stack;
let sink: Server;
let sinkUrl: string;
const received: { path: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
beforeAll(async () => {
  // A push service: the phone's endpoint takes messages, the other one was forgotten
  sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = req.url?.includes('forgotten') ? 410 : 201;
      res.end();
    });
  });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  stack = await startStack({
    env: { RIDEO_PUSH_ALLOW_HTTP: 'true', RIDEO_VAPID_SUBJECT: 'mailto:ops@example.com' },
  });
}, 60_000);
afterAll(async () => {
  await stack?.stop();
  sink?.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: ApiError) => `${err.status} ${err.body?.code}`,
  );
const device = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
  return { privateKey: ecdh.getPrivateKey(), keys };
};
async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('the installable app', () => {
  it('pushes notifications encrypted for each device, signed with VAPID; forgotten devices are dropped', async () => {
    const { publicKey } = await stack.api<{ publicKey: string }>('GET', '/push/key');
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65);
    const phone = device();
    const old = device();
    await stack.api('POST', '/push/subscriptions', { endpoint: `${sinkUrl}/push/phone`, keys: phone.keys });
    await stack.api('POST', '/push/subscriptions', { endpoint: `${sinkUrl}/push/forgotten`, keys: old.keys });
    expect(
      await code(
        stack.api('POST', '/push/subscriptions', { endpoint: 'ftp://push.example/x', keys: phone.keys }),
      ),
    ).toBe('422 validation_error');

    // A recipe that fails: the person who ran it hears about it on their devices
    const p = await stack.api<{ id: string }>('POST', '/projects', { kind: 'edit', title: 'Pushed' });
    const job = await stack.api<Job>(
      'POST',
      `/projects/${p.id}/recipes/${encodeURIComponent('builtin:clip_variations')}/run`,
      {
        params: { clipId: 'clp_000000missing' },
      },
    );
    expect((await stack.waitJob(p.id, job.id)).status).toBe('failed');
    await until(
      () => received.length,
      (n) => n >= 2,
    );
    const toPhone = received.find((r) => r.path === '/push/phone')!;
    expect(toPhone.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      ttl: '86400',
      urgency: 'normal',
      authorization: expect.stringMatching(
        new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${publicKey}$`),
      ),
    });
    const message = JSON.parse(decryptPush(toPhone.body, phone.privateKey, phone.keys).toString());
    expect(message).toEqual({
      title: 'Recipe failed',
      body: expect.stringContaining('Pushed'),
      link: `/p/${p.id}/overview`,
      tag: expect.any(String),
    });
    const notes = await stack.api<any>('GET', '/notifications');
    expect(notes.notifications[0]).toMatchObject({ kind: 'job', title: 'Recipe failed', projectId: p.id });

    // The forgotten device was dropped: the next notification goes to the phone only
    const before = received.length;
    const again = await stack.api<Job>(
      'POST',
      `/projects/${p.id}/recipes/${encodeURIComponent('builtin:clip_variations')}/run`,
      {
        params: { clipId: 'clp_000000missing' },
      },
    );
    await stack.waitJob(p.id, again.id);
    await until(
      () => received.length,
      (n) => n > before,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(received.slice(before).map((r) => r.path)).toEqual(['/push/phone']);
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_push_total\{outcome="gone"\} 1/);
    expect(metrics).toMatch(/rideo_push_total\{outcome="sent"\} 2/);

    // Unsubscribed, the phone hears nothing more
    await stack.api('DELETE', '/push/subscriptions', { endpoint: `${sinkUrl}/push/phone` });
    const quiet = received.length;
    const third = await stack.api<Job>(
      'POST',
      `/projects/${p.id}/recipes/${encodeURIComponent('builtin:clip_variations')}/run`,
      {
        params: { clipId: 'clp_000000missing' },
      },
    );
    await stack.waitJob(p.id, third.id);
    await new Promise((r) => setTimeout(r, 500));
    expect(received.length).toBe(quiet);
  }, 120_000);

  it('gathers what waits across projects: gates to approve, reviews to decide, jobs, agents', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, { storyboard: { enabled: false } });
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
    });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    const clip = Object.values<Clip>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0]!;

    // An agent asks for a review and changes the project
    const client = new Client({ name: 'Claude Code', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
    try {
      const review = await client.callTool({
        name: 'review_create',
        arguments: {
          projectId: pid,
          title: 'Look at the first clip',
          target: { kind: 'clip', clipId: clip.id },
        },
      });
      expect(review.isError).toBeFalsy();
      const updated = await client.callTool({
        name: 'project_update',
        arguments: { projectId: pid, title: 'The Keeper (agent cut)' },
      });
      expect(updated.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    const inbox = await stack.api<Inbox>('GET', '/inbox');
    const ours = <T extends { project: { id: string } }>(xs: T[]) => xs.filter((x) => x.project.id === pid);
    const wf = await stack.api<any>('GET', `/projects/${pid}/workflow`);
    const gate = wf.stages.find((s: any) => s.id === wf.stage).gate;
    if (gate?.satisfied && !gate.approved)
      expect(ours(inbox.approvals)).toEqual([
        {
          project: { id: pid, title: 'The Keeper (agent cut)' },
          stage: wf.stage,
          gate: { id: gate.id, title: gate.title },
        },
      ]);
    // Approved, the gate leaves at once for whoever asks fresh (the header's badge may be seconds behind)
    if (gate?.satisfied && !gate.approved) {
      await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: gate.id });
      // (the next stage's gate may be waiting now)
      const fresh = ours((await stack.api<Inbox>('GET', '/inbox?fresh=1')).approvals);
      expect(fresh.map((a) => a.gate.id)).not.toContain(gate.id);
    }
    expect(ours(inbox.reviews)).toEqual([
      {
        project: { id: pid, title: 'The Keeper (agent cut)' },
        review: expect.objectContaining({
          title: 'Look at the first clip',
          createdBy: 'Claude Code',
          gate: null,
        }),
      },
    ]);
    expect(ours(inbox.agents).map((a) => a.commit.agent)).toContain('Claude Code');
    expect(inbox.waiting).toBe(inbox.approvals.length + inbox.reviews.length);
    // the failed recipes of the first test are today's failures
    expect(
      inbox.jobs.filter((j) => j.job.kind === 'recipe.run').map((j) => [j.job.status, j.canCancel]),
    ).toContainEqual(['failed', false]);
  }, 180_000);
});
