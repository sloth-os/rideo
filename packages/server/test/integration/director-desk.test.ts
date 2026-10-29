import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BLOCKING_IMAGE_PHRASE, type BlockingView, boardState, type Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** The 3D director's desk (docs/design/director-desk.md) on the mock gateway. */
let stack: Stack;
let client: Client;
beforeAll(async () => {
  stack = await startStack();
  client = new Client({ name: 'Claude Code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
}, 60_000);
afterAll(async () => {
  await client?.close();
  await stack?.stop();
});

const stateOf = (pid: string) => stack.api<any>('GET', `/projects/${pid}/state`);

/** A cast-locked project with the desk on, its first scene planned and storyboarded (frames drawn from the blocking). */
async function storyboarded() {
  // A 30 s pilot: its scene is planned in two shots, so a cut can cross the line
  const { projectId } = await readyStoryProject(stack, {
    targetDurationSec: 60,
    pilotDurationSec: 30,
    generation: { promptVersion: 2 },
    blocking: { enabled: true, layoutImage: true },
    storyboard: { enabled: true, scenes: 1 },
  });
  const job = await stack.api<Job>('POST', `/projects/${projectId}/storyboard/generate`, {});
  expectSucceeded(await stack.waitJob(projectId, job.id, 180_000));
  await stack.waitIdle(projectId);
  const state = await stateOf(projectId);
  const clip = Object.values<any>(state.docs.clips).sort((a, b) => a.index - b.index)[0];
  return { projectId, clip };
}

describe("the director's desk", () => {
  it('blocks a scene with the AI before its frames are drawn, and draws each frame from its camera view', async () => {
    const { projectId, clip } = await storyboarded();
    expect(clip.blocking).toMatchObject({ source: 'ai', version: 1 });
    expect(Object.keys(clip.blocking.shots).sort()).toEqual(clip.shots.map((s: any) => s.id).sort());
    expect(clip.blocking.actors.length).toBeGreaterThan(0);
    // Every frame was drawn with the blocking line and the camera view as a reference
    const view = await stack.api<BlockingView>('GET', `/projects/${projectId}/clips/${clip.id}/blocking`);
    expect(view.state).toBe('ready');
    expect(view.issues.filter((i) => i.code === 'line_crossed')).toEqual([]);
    for (const shot of clip.shots) {
      expect(shot.board).toBeTruthy();
      const line = view.lines[shot.id];
      if (line) expect(shot.board.request.prompt).toContain(line);
      if (shot.characterIds.length) {
        expect(shot.board.request.prompt).toContain(BLOCKING_IMAGE_PHRASE);
        expect(shot.board.request.prompt).toMatch(/the blocking \(\w+ figure = /);
      }
    }
  }, 240_000);

  it('saves a blocking from the desk, brings a crossed camera back over the line, and outdates the frames it changes', async () => {
    const { projectId, clip } = await storyboarded();
    const view = await stack.api<BlockingView>('GET', `/projects/${projectId}/clips/${clip.id}/blocking`);
    const draft = structuredClone(view.draft);
    // A later cut's camera mirrored to the other side of the line between the pair
    const shots = [...clip.shots].sort((a: any, b: any) => a.index - b.index);
    expect(shots.length).toBeGreaterThan(1);
    const shot = shots.slice(1).find((s: any) => s.characterIds.length)!;
    const cam = draft.shots[shot.id]!.camera;
    Object.assign(cam, { z: -cam.z, targetZ: -cam.targetZ });
    const saved = await stack.api<BlockingView>('PUT', `/projects/${projectId}/clips/${clip.id}/blocking`, {
      blocking: draft,
    });
    expect(saved.blocking?.source).toBe('user');
    expect(saved.issues.map((i) => i.code)).toContain('line_crossed');
    // The moved camera changed its shot's frame: it is outdated, the others keep theirs
    let state = await stateOf(projectId);
    const moved = state.docs.clips[clip.id].shots.find((s: any) => s.id === shot.id);
    expect(boardState(moved, state.docs)).toBe('outdated');
    const fixed = await stack.api<BlockingView>('PUT', `/projects/${projectId}/clips/${clip.id}/blocking`, {
      blocking: saved.draft,
      fix: true,
    });
    expect(fixed.issues.filter((i) => i.code === 'line_crossed')).toEqual([]);
    state = await stateOf(projectId);
    const history = await stack.api<any[]>('GET', `/projects/${projectId}/history?limit=5`);
    expect(history.map((c) => c.message).join('\n')).toMatch(/Edit the blocking of scene 1/);
    // A blocking that does not validate is refused
    await expect(
      stack.api('PUT', `/projects/${projectId}/clips/${clip.id}/blocking`, {
        blocking: { set: { width: 'wide' } },
      }),
    ).rejects.toMatchObject({ status: 422 });
  }, 240_000);

  it("renders a shot's camera view as a PNG, over REST and MCP", async () => {
    const { projectId, clip } = await storyboarded();
    const shot = clip.shots[0];
    const res = await fetch(
      `${stack.url}/api/projects/${projectId}/clips/${clip.id}/shots/${shot.id}/blocking.png?width=320`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.readUInt32BE(0)).toBe(0x89504e47);
    expect(png.readUInt32BE(16)).toBe(320);
    const r = await client.callTool({
      name: 'blocking_render',
      arguments: { projectId, clipId: clip.id, shotId: shot.id, width: 200 },
    });
    const content = r.content as { type: string; mimeType?: string; data?: string }[];
    expect(content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(content[0]!.data!, 'base64').readUInt32BE(16)).toBe(200);
    const got = await client.callTool({ name: 'blocking_get', arguments: { projectId, clipId: clip.id } });
    const body = JSON.parse((got.content as { text: string }[])[0]!.text);
    expect(body.state).toBe('ready');
    expect(Object.keys(body.lines)).toHaveLength(clip.shots.length);
  }, 240_000);

  it('blocks a scene again on request, as a job', async () => {
    const { projectId, clip } = await storyboarded();
    const job = await stack.api<Job>('POST', `/projects/${projectId}/clips/${clip.id}/blocking/generate`, {});
    const done = await stack.waitJob(projectId, job.id);
    expectSucceeded(done);
    expect(done.result).toMatchObject({ shots: clip.shots.length });
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_blocking_total\{outcome="(clean|issues)",source="ai"\} \d/);
  }, 240_000);
});
