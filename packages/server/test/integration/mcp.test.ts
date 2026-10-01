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
      'character_voice_design',
      'character_voice_lock',
      'screenplay_import',
      'storyboard_generate',
      'shot_board_approve',
      'animatic_build',
      'shotlist_get',
      'shot_variations',
      'camera_moves',
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

  it('imports a screenplay and reads the storyboard and the shot list', async () => {
    const project = await call('project_create', { kind: 'story', title: 'Agent import' });
    const imported = await call('screenplay_import', {
      projectId: project.id,
      text: 'Title: Two Rooms\n\nINT. ROOM ONE - DAY\n\nA lamp flickers.\n\nNOVA\nHello?\n\nEXT. YARD - NIGHT\n\nWind.\n',
    });
    expect(imported).toMatchObject({ title: 'Two Rooms', scenes: 2, characters: 1, elements: 2 });
    await expect(
      call('screenplay_import', { projectId: project.id, text: 'INT. X - DAY\n\nY.\n' }),
    ).rejects.toMatchObject({ body: { code: 'conflict' } });
    const summary = await call('project_get', { projectId: project.id });
    expect(summary.storyboard).toMatchObject({ enabled: true, scenes: 2, planned: 0, shots: 0, approved: 0 });
    expect(summary.screenplay.scenes).toHaveLength(2);
    // storyboard_generate needs the locked cast; the shot list lists what is planned (nothing yet)
    const { csv } = await call<{ csv: string }>('shotlist_get', { projectId: project.id });
    expect(csv.startsWith('scene,clip,shot,')).toBe(true);
    expect(csv.trim().split('\r\n')).toHaveLength(1);
    await expect(call('animatic_build', { projectId: project.id })).rejects.toMatchObject({
      body: { code: 'validation_error' },
    });
    // Directing controls (docs/design/directing.md)
    const moves = await call<{ moves: { id: string }[]; lenses: { mm: number }[] }>('camera_moves', {});
    expect(moves.moves.map((m) => m.id)).toContain('dolly_zoom');
    expect(moves.lenses.map((l) => l.mm)).toContain(85);
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
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    // A real person's likeness needs a complete consent record (docs/design/provenance.md#consent-records).
    await expect(
      call('character_add_reference', {
        projectId: project.id,
        characterId: c.id,
        uri: png,
        consent: { depictsRealPerson: true, subject: 'Mira Vale' },
      }),
    ).rejects.toMatchObject({ body: { code: 'consent_required', errors: ['grantedBy', 'grantedAt'] } });
    const withRef = await call('character_add_reference', {
      projectId: project.id,
      characterId: c.id,
      uri: png,
      view: 'front',
      consent: { depictsRealPerson: false },
    });
    expect(withRef.references[0].consent).toMatchObject({
      depictsRealPerson: false,
      recordedBy: { kind: 'agent' },
    });
    const locked = await call('character_lock', { projectId: project.id, characterId: c.id });
    expect(locked.lock.locked).toBe(true);
    // Voices over MCP (docs/design/dialogue.md#surfaces): design, pick a preview, lock.
    const design = await call('character_voice_design', { projectId: project.id, characterId: c.id });
    expect((await call('job_wait', { projectId: project.id, jobId: design.id, timeoutSec: 60 })).status).toBe(
      'succeeded',
    );
    const voiced = (await call('project_get', { projectId: project.id })).characters[0].voice;
    expect(voiced).toMatchObject({ status: 'candidates', locked: false });
    expect(voiced.candidates).toHaveLength(3);
    await call('character_voice_select', {
      projectId: project.id,
      characterId: c.id,
      candidateId: voiced.candidates[0].id,
    });
    const voiceLocked = await call('character_voice_lock', { projectId: project.id, characterId: c.id });
    expect(voiceLocked.voice.lock).toMatchObject({ locked: true, version: 1 });
    // A cloned real voice needs the full consent record; a locked voice cannot be replaced (V2).
    await expect(
      call('character_voice_clone', {
        projectId: project.id,
        characterId: c.id,
        uri: png,
        consent: { depictsRealPerson: true, subject: 'Mira Vale' },
      }),
    ).rejects.toMatchObject({ body: { code: 'voice_locked' } });
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
