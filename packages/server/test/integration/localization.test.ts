import { type Clip, DIALOGUE_TRACK_ID, type Job, type Localization, type Timeline } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEditorWorker } from '../helpers/editor-worker';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Subtitles and localization (docs/design/localization.md) on the mock gateway. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => stack?.stop());

const stateOf = (pid: string) => stack.api<any>('GET', `/projects/${pid}/state`);
const text = async (path: string) => {
  const res = await fetch(`${stack.url}/api${path}`);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
};

/** The first scene generated with its first speaking shot framed as a close-up, approved and assembled. */
async function speakingCut() {
  const { projectId: pid, state } = await readyStoryProject(stack, { storyboard: { enabled: false } });
  const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  expectSucceeded(await stack.waitJob(pid, plan.id));
  let clip = Object.values<Clip>((await stateOf(pid)).docs.clips)[0]!;
  const speaking = clip.shots.find((s) => s.dialogue.some((d) => d.characterId))!;
  expect(speaking).toBeTruthy();
  await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${speaking.id}`, {
    camera: { ...speaking.camera, framing: 'close_up' },
  });
  const gen = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
  expectSucceeded(await stack.waitJob(pid, gen.id, 180_000));
  await stack.waitIdle(pid);
  await stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`);
  await stack.api('POST', `/projects/${pid}/timeline/assemble`, { captions: true });
  clip = Object.values<Clip>((await stateOf(pid)).docs.clips)[0]!;
  return { pid, clip, speaking };
}

describe('subtitles and localization', () => {
  let pid: string;
  let speakingShotId: string;

  it('exports SRT and WebVTT with word timings from the speech', async () => {
    const cut = await speakingCut();
    pid = cut.pid;
    speakingShotId = cut.speaking.id;
    const srt = await text(`/projects/${pid}/subtitles.srt`);
    expect(srt.status).toBe(200);
    expect(srt.type).toContain('application/x-subrip');
    expect(srt.body).toMatch(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n\S/);
    const vtt = await text(`/projects/${pid}/subtitles.vtt`);
    expect(vtt.body.startsWith('WEBVTT\n\n')).toBe(true);
    // ElevenLabs aligned the words: cue timestamps inside the cue
    expect(vtt.body).toMatch(/<\d{2}:\d{2}:\d{2}\.\d{3}>/);
    const t = (await stateOf(pid)).docs.timeline as Timeline;
    const captions = t.tracks
      .find((x) => x.kind === 'text')!
      .items.filter((i: any) => i.style.preset === 'caption');
    expect(captions.length).toBeGreaterThan(0);
    expect((captions[0] as any).words.length).toBeGreaterThan(0);
    // no Spanish yet
    await expect(stack.api('GET', `/projects/${pid}/subtitles.srt?language=es`)).rejects.toMatchObject({
      status: 409,
      body: { code: 'localization_incomplete' },
    });
  }, 300_000);

  it('translates, dubs with the locked voices and lip-syncs the close-up', async () => {
    const job = await stack.api<Job>('POST', `/projects/${pid}/localizations`, {
      language: 'es',
      dub: true,
      lipSync: true,
    });
    const done = await stack.waitJob(pid, job.id, 300_000);
    expectSucceeded(done);
    expect(done.result).toMatchObject({ language: 'es', lipSynced: 1 });
    const [es] = await stack.api<(Localization & { state: any })[]>('GET', `/projects/${pid}/localizations`);
    expect(es!.name).toBe('Spanish');
    expect(es!.state.lines.current).toBe(es!.state.lines.total);
    expect(es!.state.dubs).toMatchObject({ current: es!.state.dubs.needed, lipSynced: 1 });
    expect(es!.lines.every((l) => l.text.startsWith('«es» '))).toBe(true);
    const dubs = Object.values(es!.dubs);
    for (const d of dubs) {
      expect(d.dialogue.path).toMatch(/^media\/dialogue\/es-/);
      expect(d.lines.every((l) => l.text.startsWith('«es» '))).toBe(true);
    }
    const synced = dubs.find((d) => d.video)!;
    expect(synced.shotId).toBe(speakingShotId);
    expect(synced.watermarkId).toMatch(/^wm_/);
    expect(synced.contentCredentials?.manifest).toMatch(/^urn:c2pa:/);
    const srt = await text(`/projects/${pid}/subtitles.srt?language=es`);
    expect(srt.body).toContain('«es» ');
    // MCP-equal surface: the localization is a document in the state
    expect((await stateOf(pid)).docs.localizations.es.id).toBe('es');
  }, 300_000);

  it('keeps edited lines, makes their dub stale and redubs only that take', async () => {
    const [es] = await stack.api<Localization[]>('GET', `/projects/${pid}/localizations`);
    const line = es!.lines.find((l) => l.shotId === speakingShotId)!;
    await stack.api('PATCH', `/projects/${pid}/localizations/es/lines`, {
      shotId: line.shotId,
      index: line.index,
      text: 'Hola, ¿quién escribe?',
    });
    let [state] = await stack.api<any[]>('GET', `/projects/${pid}/localizations`);
    expect(state.lines.find((l: any) => l.shotId === speakingShotId && l.index === line.index)).toMatchObject(
      {
        text: 'Hola, ¿quién escribe?',
        edited: true,
      },
    );
    expect(state.state.dubs.stale).toHaveLength(1);
    await expect(
      stack.api('POST', `/projects/${pid}/exports`, { quality: 'draft', language: 'es', dubbed: true }),
    ).rejects.toMatchObject({ status: 409, body: { code: 'localization_incomplete' } });
    const job = await stack.api<Job>('POST', `/projects/${pid}/localizations`, { language: 'es', dub: true });
    const done = await stack.waitJob(pid, job.id, 300_000);
    expectSucceeded(done);
    expect(done.result).toMatchObject({ translated: 0, dubbed: 1 });
    [state] = await stack.api<any[]>('GET', `/projects/${pid}/localizations`);
    expect(state.state.dubs.stale).toEqual([]);
    // the edit survived translating again
    expect(state.lines.find((l: any) => l.shotId === speakingShotId).text).toBe('Hola, ¿quién escribe?');
  }, 300_000);

  it('exports a dubbed Spanish variant with sidecar subtitles, and a subtitled one', async () => {
    const editor = await startEditorWorker(stack, pid);
    try {
      const dubbed = await stack.api<any>('POST', `/projects/${pid}/exports`, {
        quality: 'draft',
        language: 'es',
        dubbed: true,
        captions: 'sidecar',
      });
      expect(dubbed.export).toMatchObject({ language: 'es', dubbed: true, captions: 'sidecar' });
      expect(dubbed.export.subtitles).toMatchObject({
        language: 'es',
        srt: { mime: 'application/x-subrip' },
      });
      expect(dubbed.job.params).toMatchObject({
        timelinePath: `renders/${dubbed.export.id}.json`,
        timelineCommit: null,
      });
      const render = await stack.api<Timeline>(
        'GET',
        `/projects/${pid}/docs/renders/${dubbed.export.id}.json`,
      );
      expect(
        render.tracks.find((t) => t.kind === 'text')!.items.filter((i: any) => i.style.preset === 'caption'),
      ).toEqual([]);
      const dialogue = render.tracks.find((t) => t.id === DIALOGUE_TRACK_ID)!.items;
      expect(dialogue.every((d: any) => d.source.media.path.startsWith('media/dialogue/es-'))).toBe(true);
      const done = await stack.waitExport(pid, dubbed.export.id);
      expect(done.status).toBe('succeeded');
      expect(done.contentCredentials.ingredients).toBeGreaterThan(0);
      const srt = await fetch(`${stack.url}/api/projects/${pid}/media/${done.subtitles.srt.path}`);
      // the dubbed lines: the translations, one of them edited by hand
      expect(await srt.text()).toMatch(/«es» |Hola, ¿quién escribe\?/);

      const subtitled = await stack.api<any>('POST', `/projects/${pid}/exports`, {
        quality: 'draft',
        language: 'es',
      });
      const r2 = await stack.api<Timeline>(
        'GET',
        `/projects/${pid}/docs/renders/${subtitled.export.id}.json`,
      );
      const caps = r2.tracks
        .find((t) => t.kind === 'text')!
        .items.filter((i: any) => i.style.preset === 'caption');
      expect(caps.length).toBeGreaterThan(0);
      expect(caps.every((c: any) => c.text.includes('«es» ') || c.text.includes('Hola'))).toBe(true);
      expect((await stack.waitExport(pid, subtitled.export.id)).status).toBe('succeeded');
    } finally {
      await editor.stop();
    }
    await expect(
      stack.api('POST', `/projects/${pid}/exports`, { quality: 'draft', language: 'fr' }),
    ).rejects.toMatchObject({ status: 409, body: { code: 'localization_incomplete' } });
  }, 600_000);
});
