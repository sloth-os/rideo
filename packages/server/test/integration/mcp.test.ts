import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ServerMessage } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from '../helpers/stack';

let stack: Stack;
let client: Client;

async function call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw Object.assign(new Error(text), { body: JSON.parse(text) });
  return JSON.parse(text) as T;
}

beforeAll(async () => {
  stack = await startStack();
  client = new Client({ name: 'Claude Code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
});
afterAll(async () => {
  await client?.close();
  await stack?.stop();
});

describe('MCP server', () => {
  it('exposes the tool catalogue and resources', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      'project_create',
      'screenplay_generate',
      'character_lock',
      'clip_generate',
      'clip_approve',
      'timeline_apply',
      'history_restore',
      'watermark_detect',
      'ui_navigate',
      'job_wait',
    ]) {
      expect(tools).toContain(name);
    }
    expect(tools.length).toBeGreaterThanOrEqual(55);
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain('rideo://projects');
  });

  it('drives a production, attributes commits to the agent and steers the live UI', async () => {
    const project = await call('project_create', {
      kind: 'story',
      title: 'Agent film',
      prompt: 'A robot learns to paint',
      targetDurationSec: 30,
      pilotDurationSec: 10,
    });
    const ws = new WebSocket(`${stack.url.replace('http', 'ws')}/api/live?projectId=${project.id}`);
    const messages: ServerMessage[] = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as ServerMessage;
      messages.push(msg);
      if (msg.type === 'ui') ws.send(JSON.stringify({ type: 'ui-ack', commandId: msg.command.id, ok: true }));
    };
    await new Promise((r) => ws.addEventListener('open', r));
    ws.send(
      JSON.stringify({
        type: 'presence',
        projectId: project.id,
        route: `/p/${project.id}/story`,
        viewport: { width: 412, height: 915 },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    const sessions = await call<any[]>('ui_sessions', { projectId: project.id });
    expect(sessions[0].presence.viewport.width).toBe(412);
    const nav = await call('ui_navigate', { projectId: project.id, view: 'cast' });
    expect(nav.acked).toHaveLength(1);

    const job = await call('screenplay_generate', { projectId: project.id });
    const done = await call('job_wait', { projectId: project.id, jobId: job.id, timeoutSec: 60 });
    expect(done.status).toBe('succeeded');
    const summary = await call('project_get', { projectId: project.id });
    expect(summary.workflow.stage).toBe('screenplay');
    expect(summary.characters.length).toBe(2);

    const c = summary.characters[0];
    await expect(call('character_lock', { projectId: project.id, characterId: c.id })).rejects.toThrow(
      /Approve at least one reference/,
    );
    await call('character_add_reference', {
      projectId: project.id,
      characterId: c.id,
      uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      view: 'front',
    });
    const locked = await call('character_lock', { projectId: project.id, characterId: c.id });
    expect(locked.lock.locked).toBe(true);
    await call('ui_focus', { projectId: project.id, kind: 'character', id: c.id });

    await call('project_update', { projectId: project.id, settings: { approvals: { allowAgents: false } } });
    const denied = await call('workflow_approve', {
      projectId: project.id,
      gate: 'screenplay_approved',
    }).catch((e) => e.body);
    expect(denied.code).toBe('forbidden');

    const log = await call<any[]>('history_log', { projectId: project.id, limit: 50 });
    expect(log.find((x) => x.message.startsWith('Lock character'))?.author).toMatchObject({
      kind: 'agent',
      name: 'Claude Code',
    });

    await new Promise((r) => setTimeout(r, 200));
    const events = messages.filter((m): m is Extract<ServerMessage, { type: 'event' }> => m.type === 'event');
    expect(
      events.some((e) => e.event.kind === 'commit' && e.event.commit.author.name === 'Claude Code'),
    ).toBe(true);
    expect(events.some((e) => e.event.kind === 'job' && e.event.job.status === 'succeeded')).toBe(true);
    expect(
      events.some((e) => e.event.kind === 'activity' && e.event.summary.includes('character_lock')),
    ).toBe(true);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const ui = messages
      .filter((m) => m.type === 'ui')
      .map((m) => (m as Extract<ServerMessage, { type: 'ui' }>).command.action);
    expect(ui).toEqual(['navigate', 'focus']);
    ws.close();

    const md = await client.readResource({ uri: `rideo://projects/${project.id}/screenplay.md` });
    expect((md.contents[0] as { text: string }).text).toContain('## Scenes');
  }, 180_000);
});
