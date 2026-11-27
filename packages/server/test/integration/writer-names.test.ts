import type { Character, Element, Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSucceeded, NO_REVIEWS, type Stack, startStack } from '../helpers/stack';

/**
 * The project's names (docs/design/continuity.md#storytelling): the writer is told the characters, places and props a
 * project holds before its screenplay, and the mock writer keeps their names as the real one is told to, so the scenes
 * link to them instead of to new ones.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.stop();
});

async function storyProject(title: string): Promise<string> {
  const p = await stack.api<{ id: string }>('POST', '/projects', {
    kind: 'story',
    title,
    brief: { prompt: 'A harbour pilot receives letters from the future' },
    settings: {
      targetDurationSec: 30,
      pilotDurationSec: 10,
      resolution: { width: 320, height: 180 },
      review: NO_REVIEWS,
      storyboard: { production: false },
      consistency: { turnaround: false },
    },
  });
  return p.id;
}

async function run(pid: string, path: string, body: unknown = {}): Promise<void> {
  const job = await stack.api<Job>('POST', `/projects/${pid}${path}`, body);
  expectSucceeded(await stack.waitJob(pid, job.id));
}

const docsOf = async (pid: string) => (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;

describe("the writer keeps the project's names", () => {
  it("tells a new project's writer nothing more", async () => {
    const pid = await storyProject('Episode 1');
    await run(pid, '/screenplay/generate');
    expect(stack.gw.counters.lastInputs['screenplay.generate']).not.toHaveProperty('existing');
  });

  it('tells the writer the characters and places a project already has, and its scenes link to them', async () => {
    const pid = await storyProject('Episode 2');
    // A locked character and a place with an alias, as a library's would arrive before episode 2 is written
    const mira = await stack.api<Character>('POST', `/projects/${pid}/characters`, {
      name: 'Mira Vale',
      role: 'protagonist',
      summary: 'A harbour pilot who distrusts easy answers.',
      identity: { age: 'early 30s', gender: 'woman', ethnicity: 'East Asian', hair: 'jet-black bob' },
    });
    await run(pid, `/characters/${mira.id}/references/generate`, { views: ['front'] });
    for (const r of (await docsOf(pid)).characters[mira.id].references)
      await stack.api('PATCH', `/projects/${pid}/characters/${mira.id}/references/${r.id}`, {
        approved: true,
      });
    await stack.api('POST', `/projects/${pid}/characters/${mira.id}/lock`);
    const harbor = await stack.api<Element>('POST', `/projects/${pid}/elements`, {
      kind: 'location',
      name: 'Harbor',
      description: 'a stone harbour wall with fishing boats and gulls',
      aliases: ['the old docks'],
    });
    const before = await docsOf(pid);
    expect(before.characters[mira.id].lock.locked).toBe(true);

    await run(pid, '/screenplay/generate');
    const told = stack.gw.counters.lastInputs['screenplay.generate'] as Record<string, any>;
    expect(told.existing).toEqual({
      characters: [
        { name: 'Mira Vale', role: 'protagonist', identity: 'early 30s woman, East Asian, jet-black bob' },
      ],
      elements: [{ kind: 'location', name: 'Harbor', aliases: ['the old docks'] }],
    });

    const docs = await docsOf(pid);
    // One Mira, exactly as she was (same id, seed, references and lock)
    const miras = Object.values<Character>(docs.characters).filter((c) => /^mira\b/i.test(c.name));
    expect(miras.map((c) => c.id)).toEqual([mira.id]);
    expect(docs.characters[mira.id]).toEqual(before.characters[mira.id]);
    // One Harbor, as it was, and no second place for "the old docks"
    const harbors = Object.values<Element>(docs.elements).filter((e) =>
      [e.name, ...e.aliases].some((n) => /^(harbor|the old docks)$/i.test(n)),
    );
    expect(harbors.map((e) => e.id)).toEqual([harbor.id]);
    expect(docs.elements[harbor.id]).toEqual(before.elements[harbor.id]);
    // The first scene is at the Harbor with Mira in it, speaking
    const first = docs.screenplay.scenes[0];
    expect(first.locationId).toBe(harbor.id);
    expect(first.characterIds).toContain(mira.id);
    expect(first.dialogue.map((d: { characterId: string | null }) => d.characterId)).toContain(mira.id);
    // The writer added a second lead of its own, under a name of its own
    expect(Object.keys(docs.characters)).toHaveLength(2);

    await run(pid, '/screenplay/extend', { beats: 1 });
    const extended = stack.gw.counters.lastInputs['screenplay.extend'] as Record<string, any>;
    expect(extended.existing.characters).toContainEqual(
      expect.objectContaining({ name: 'Mira Vale', role: 'protagonist' }),
    );
    expect(extended.existing.elements).toContainEqual({
      kind: 'location',
      name: 'Harbor',
      aliases: ['the old docks'],
    });
    const after = await docsOf(pid);
    expect(after.screenplay.scenes).toHaveLength(2);
    expect(after.characters[mira.id]).toEqual(before.characters[mira.id]);
    expect(after.elements[harbor.id]).toEqual(before.elements[harbor.id]);
  });
});
