import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Clip, type Job, type Recipe, type Timeline, voiceOf } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFootage, uploadReady } from '../helpers/media';
import { type ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Agents (docs/design/agents.md): recipes, prompts, resources, variations of many shots and casting every voice. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => stack?.stop());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: ApiError) => `${err.status} ${err.body?.code}`,
  );

async function editProject(): Promise<string> {
  const p = await stack.api<{ id: string }>('POST', '/projects', {
    kind: 'edit',
    title: 'Recipes',
    settings: { resolution: { width: 320, height: 180 } },
  });
  const r = await uploadReady(stack, p.id, await makeFootage(stack.dataDir), {
    mime: 'video/mp4',
    name: 'a.mp4',
  });
  const t = await stack.api<Timeline>('GET', `/projects/${p.id}/timeline`);
  await stack.api('POST', `/projects/${p.id}/timeline/ops`, {
    ops: [
      {
        op: 'insert',
        trackId: t.tracks[0]!.id,
        item: { kind: 'video', source: { type: 'media', media: r.media, resourceId: r.id }, in: 0, out: 6 },
      },
    ],
  });
  return p.id;
}

describe('recipes', () => {
  it('saves studio recipes that pass validation and runs them step by step on a project', async () => {
    const pid = await editProject();
    const list = await stack.api<Recipe[]>('GET', '/recipes');
    expect(list.slice(0, 4).every((r) => r.builtin)).toBe(true);
    // validation: unknown tools, arguments that do not fit, placeholders that are not parameters
    const bad = (steps: unknown[]) =>
      code(stack.api('POST', '/recipes', { name: 'Bad', params: [{ name: 'texts', type: 'ids' }], steps }));
    expect(await bad([{ tool: 'no_such_tool' }])).toBe('422 validation_error');
    expect(await bad([{ tool: 'timeline_apply', args: { projectId: '{{projectId}}', ops: 'many' } }])).toBe(
      '422 validation_error',
    );
    expect(
      await bad([{ tool: 'timeline_apply', args: { projectId: '{{projectId}}', ops: '{{nope}}' } }]),
    ).toBe('422 validation_error');
    // One title per text, then the cut read back
    const recipe = await stack.api<Recipe>('POST', '/recipes', {
      name: 'Titles from a list',
      description: 'A title every four seconds',
      params: [
        { name: 'texts', type: 'ids', required: true },
        { name: 'seconds', type: 'number', default: 2 },
      ],
      steps: [
        {
          tool: 'timeline_apply',
          forEach: '{{texts}}',
          args: {
            projectId: '{{projectId}}',
            ops: [
              {
                op: 'add_text',
                item: {
                  kind: 'text',
                  start: 0,
                  duration: '{{seconds}}',
                  text: 'Title: {{item}}',
                  style: { preset: 'title' },
                },
              },
            ],
          },
          label: 'Add the titles',
        },
        { tool: 'timeline_get', args: { projectId: '{{projectId}}' }, label: 'Read the cut' },
      ],
    });
    expect(recipe).toMatchObject({
      id: expect.stringMatching(/^rcp_/),
      builtin: false,
      createdBy: { kind: 'user' },
    });
    expect((await stack.api<Recipe[]>('GET', '/recipes')).map((r) => r.id)).toContain(recipe.id);
    expect(await code(stack.api('POST', `/projects/${pid}/recipes/${recipe.id}/run`, { params: {} }))).toBe(
      '422 validation_error',
    );
    const job = await stack.api<Job>('POST', `/projects/${pid}/recipes/${recipe.id}/run`, {
      params: { texts: ['Opening', 'Closing'] },
    });
    expect(job).toMatchObject({ kind: 'recipe.run', lane: 'control' });
    const done = expectSucceeded(await stack.waitJob(pid, job.id));
    expect(done.result).toMatchObject({
      recipe: 'Titles from a list',
      steps: [
        { step: 1, tool: 'timeline_apply', ok: true },
        { step: 2, tool: 'timeline_get', ok: true },
      ],
    });
    const t = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    const texts = t.tracks
      .filter((x) => x.kind === 'text')
      .flatMap((x) => x.items as { text: string; duration: number }[]);
    expect(texts.map((x) => [x.text, x.duration])).toEqual([
      ['Title: Opening', 2],
      ['Title: Closing', 2],
    ]);
    // like every job, the recipe commits as Rideo on behalf of who ran it
    const log = await stack.api<any[]>('GET', `/projects/${pid}/history?path=timeline.json&limit=2`);
    expect(log[0].author).toMatchObject({ kind: 'system', onBehalfOf: { kind: 'user' } });

    // A failing step stops the recipe with its error
    const failing = await stack.api<Recipe>('POST', '/recipes', {
      name: 'Trim nothing',
      params: [{ name: 'itemId', type: 'id', required: true }],
      steps: [
        {
          tool: 'timeline_apply',
          args: { projectId: '{{projectId}}', ops: [{ op: 'trim', itemId: '{{itemId}}', out: 1 }] },
        },
      ],
    });
    const run = await stack.api<Job>('POST', `/projects/${pid}/recipes/${failing.id}/run`, {
      params: { itemId: 'itm_000000000404' },
    });
    const failed = await stack.waitJob(pid, run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.message).toMatch(/^step 1 \(timeline_apply\): item itm_000000000404 not found/);

    // Built-ins cannot be deleted; studio recipes can
    expect(await code(stack.api('DELETE', '/recipes/builtin:dub'))).toBe('403 forbidden');
    await stack.api('DELETE', `/recipes/${failing.id}`);
    expect((await stack.api<Recipe[]>('GET', '/recipes')).map((r) => r.id)).not.toContain(failing.id);
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_recipe_steps_total\{outcome="ok",tool="timeline_apply"\} 1/);
  }, 120_000);

  it('casts every voice with the built-in recipe', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Voices',
      brief: { prompt: 'Two sisters argue about the lighthouse' },
      settings: { resolution: { width: 320, height: 180 } },
    });
    expectSucceeded(
      await stack.waitJob(
        p.id,
        (await stack.api<Job>('POST', `/projects/${p.id}/screenplay/generate`, {})).id,
      ),
    );
    const job = await stack.api<Job>('POST', `/projects/${p.id}/recipes/builtin:cast_voices/run`, {
      params: {},
    });
    const done = expectSucceeded(await stack.waitJob(p.id, job.id, 120_000));
    expect(done.result).toMatchObject({
      recipe: 'Cast every voice',
      steps: [{ tool: 'voices_cast', ok: true }],
    });
    const state = await stack.api<any>('GET', `/projects/${p.id}/state`);
    const speaking = Object.values<any>(state.docs.characters).filter((c) =>
      state.docs.screenplay.scenes.some((s: any) => s.dialogue.some((d: any) => d.characterId === c.id)),
    );
    expect(speaking.length).toBeGreaterThan(0);
    for (const c of speaking) expect(voiceOf(c).lock.locked).toBe(true);
  }, 180_000);
});

describe('agents over MCP', () => {
  it('get prompts filled with the project, read the new resources, vary a clip and run recipes', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, { storyboard: { enabled: false } });
    const scene = state.docs.screenplay.scenes[0];
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, { sceneId: scene.id });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    const clip = Object.values<Clip>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0]!;

    const client = new Client({ name: 'Claude Code', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`));
    await client.connect(transport);
    try {
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toEqual([
        'direct_scene',
        'address_review_notes',
        'cast_voices',
        'dub_film',
        'make_variations',
      ]);
      const direct = await client.getPrompt({
        name: 'direct_scene',
        arguments: { projectId: pid, sceneId: scene.id },
      });
      const text = (direct.messages[0]!.content as { text: string }).text;
      expect(text).toContain(`**${scene.heading}**`);
      expect(text).toContain(`Clip 1 \`${clip.id}\``);
      expect(text).toContain('`shot_update`');
      await expect(
        client.getPrompt({
          name: 'direct_scene',
          arguments: { projectId: pid, sceneId: 'scn_000000000404' },
        }),
      ).rejects.toThrow();

      const notes = await client.getPrompt({ name: 'address_review_notes', arguments: { projectId: pid } });
      expect((notes.messages[0]!.content as { text: string }).text).toContain(
        '_None: everything is addressed._',
      );

      const read = async (uri: string) => {
        const r = await client.readResource({ uri });
        return JSON.parse((r.contents[0] as { text: string }).text);
      };
      expect((await read('rideo://recipes')).map((r: Recipe) => r.id)).toContain('builtin:cast_voices');
      const sceneDoc = await read(`rideo://projects/${pid}/scenes/${scene.id}`);
      expect(sceneDoc).toMatchObject({
        scene: { id: scene.id },
        clips: [{ id: clip.id, shots: expect.any(Array) }],
      });
      expect(await read(`rideo://projects/${pid}/review-notes`)).toEqual([]);
      expect(await read(`rideo://projects/${pid}/timeline`)).toBeNull();

      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        return { error: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
      };
      // Variations of every shot: one job per new take
      const vary = await call('batch_variations', { projectId: pid, clipId: clip.id, count: 2 });
      expect(vary.error).toBe(false);
      expect(vary.body).toHaveLength(clip.shots.length * 2);
      for (const j of vary.body as Job[]) expectSucceeded(await stack.waitJob(pid, j.id, 180_000));
      const after = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clip.id] as Clip;
      for (const s of after.shots) expect(s.takes.map((t) => t.variation).sort()).toEqual([1, 2]);

      // Recipes from an agent
      const made = await call('recipe_create', {
        name: 'Variations again',
        params: [{ name: 'clipId', type: 'id', required: true }],
        steps: [
          {
            tool: 'batch_variations',
            args: { projectId: '{{projectId}}', clipId: '{{clipId}}', count: 2 },
            wait: true,
          },
        ],
      });
      expect(made.error).toBe(false);
      const run = await call('recipe_run', {
        projectId: pid,
        recipeId: made.body.id,
        params: { clipId: clip.id },
      });
      expectSucceeded(await stack.waitJob(pid, run.body.id, 300_000));
      const again = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clip.id] as Clip;
      for (const s of again.shots) expect(s.takes.length).toBe(4);
      const unknown = await call('recipe_run', { projectId: pid, recipeId: 'rcp_000000000404' });
      expect(unknown).toMatchObject({ error: true, body: { code: 'not_found' } });
    } finally {
      await client.close();
    }
  }, 600_000);
});
