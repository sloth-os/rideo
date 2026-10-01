import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Reader } from '@contentauth/c2pa-node';
import {
  type Clip,
  DEFAULT_TRACK_IDS,
  DIALOGUE_TRACK_ID,
  EFFECTS_TRACK_ID,
  type Job,
  loudnormFilter,
  parseLoudnorm,
  type Resource,
  type Timeline,
  type VideoItem,
} from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEditorWorker } from '../helpers/editor-worker';
import { ff } from '../helpers/media';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Post audio (docs/design/post-audio.md): the score, effects from action lines, loudness and stems. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => stack?.stop());

const stateOf = (pid: string) => stack.api<any>('GET', `/projects/${pid}/state`);

/** A story with its first scene generated (TTS dialogue), approved and assembled. */
async function assembledCut() {
  const { projectId: pid, state } = await readyStoryProject(stack, { storyboard: { enabled: false } });
  const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
    generate: true,
  });
  expectSucceeded(await stack.waitJob(pid, plan.id, 180_000));
  await stack.waitIdle(pid, 180_000);
  const clip = Object.values<Clip>((await stateOf(pid)).docs.clips)[0]!;
  await stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`);
  const { timeline } = await stack.api<{ timeline: Timeline }>('POST', `/projects/${pid}/timeline/assemble`, {
    captions: true,
  });
  return { pid, timeline };
}

async function download(pid: string, path: string, name: string): Promise<string> {
  const res = await fetch(`${stack.url}/api/projects/${pid}/media/${path}`);
  expect(res.ok).toBe(true);
  const out = join(stack.dataDir, name);
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

describe('post audio', () => {
  it('scores the cut, adds effects from the action lines and exports normalized with stems', async () => {
    const { pid, timeline } = await assembledCut();
    // the assembled cut ducks its music under the TTS lines
    expect(timeline.mix?.ducking).toMatchObject({ enabled: true, depthDb: -12 });
    const dialogue = timeline.tracks.find((t) => t.id === DIALOGUE_TRACK_ID);
    expect(dialogue?.items.length).toBeGreaterThan(0);
    for (const item of dialogue!.items)
      expect((item as { speech?: unknown[] }).speech?.length).toBeGreaterThan(0);

    // Score: one cue per scene, generated through the gateway with the planned composition
    const score = await stack.api<Job>('POST', `/projects/${pid}/timeline/score`, {
      direction: 'sparse piano',
    });
    const scored = await stack.waitJob(pid, score.id, 120_000);
    expectSucceeded(scored);
    let state = await stateOf(pid);
    const cues = Object.values<Resource>(state.docs.resources).filter((r) => r.role === 'music');
    expect(cues).toHaveLength((scored.result as { cues: number }).cues);
    expect(cues[0]!.name).toMatch(/^Cue 1 — /);
    expect(cues[0]!.generation?.prompt).toContain('sparse piano');
    const music = state.docs.timeline.tracks.find((t: { id: string }) => t.id === DEFAULT_TRACK_IDS.audio);
    expect(music.items.length).toBeGreaterThanOrEqual(cues.length);
    expect(music.items[0]).toMatchObject({ label: 'Cue 1', start: 0, volume: 0.5 });
    const request = [...stack.gw.store.requests.values()].find(
      (r: any) => r?.parameters?.title === 'Cue 1',
    ) as any;
    expect(request.parameters).toMatchObject({ instrumental: true, file_format: 'mp3' });
    expect(request.input[0].text).toContain('Instrumental underscore');

    // Effects: one spot per take of the cut, at 30% of the shot, on the Effects track after the Dialogue track
    const calls = stack.gw.counters.proxyCalls['api.elevenlabs.io'] ?? 0;
    const sfx = await stack.api<Job>('POST', `/projects/${pid}/timeline/effects`);
    expectSucceeded(await stack.waitJob(pid, sfx.id, 120_000));
    state = await stateOf(pid);
    const t = state.docs.timeline as Timeline;
    const ids = t.tracks.map((x) => x.id);
    expect(ids.indexOf(EFFECTS_TRACK_ID)).toBe(ids.indexOf(DIALOGUE_TRACK_ID) + 1);
    const fx = t.tracks.find((x) => x.id === EFFECTS_TRACK_ID)!;
    const shots = (t.tracks[0]!.items as VideoItem[]).filter((i) => i.source.type === 'take');
    expect(fx.items).toHaveLength(shots.length);
    for (const [k, item] of fx.items.entries()) {
      const shot = shots[k]!;
      expect((item as { label: string }).label).toMatch(/^SFX: the sound of /);
      expect(item.start).toBeGreaterThanOrEqual(shot.start);
      expect(item.start).toBeLessThan(shot.start + (shot.out - shot.in));
    }
    expect(
      Object.values<Resource>(state.docs.resources).filter((r) => r.role === 'sfx').length,
    ).toBeGreaterThan(0);
    expect(stack.gw.counters.proxyCalls['api.elevenlabs.io']).toBeGreaterThan(calls);

    // Export: broadcast loudness (EBU R128) and the three stems
    const editor = await startEditorWorker(stack, pid);
    const created = await stack.api<any>('POST', `/projects/${pid}/exports`, {
      quality: 'draft',
      loudness: 'broadcast',
      stems: true,
    });
    expect(created.export.loudness).toMatchObject({ target: 'broadcast', mode: 'pending' });
    expect(created.job.params.stems).toBe(true);
    const done = await stack.waitExport(pid, created.export.id);
    await editor.stop();
    expect(done.status).toBe('succeeded');
    expect(['linear', 'dynamic']).toContain(done.loudness.mode);
    expect(Math.abs(done.loudness.integratedLufs - -23)).toBeLessThan(1);
    expect(done.loudness.truePeakDb).toBeLessThanOrEqual(-0.9);
    for (const role of ['dialogue', 'music', 'effects']) {
      expect(done.stems[role]).toMatchObject({
        mime: 'audio/wav',
        path: expect.stringMatching(/^media\/stems\//),
      });
      expect(Math.abs(done.stems[role].durationSec - done.durationSec)).toBeLessThan(0.1);
    }
    // stems carry Content Credentials placing their own sources
    const stem = await download(pid, done.stems.music.path, 'music.wav');
    const reader = await Reader.fromAsset({ path: stem, mimeType: 'audio/wav' });
    const store = reader!.json() as any;
    const manifest = store.manifests[store.active_manifest];
    expect(manifest.title).toMatch(/music stem\.wav$/);
    expect(manifest.assertions.find((a: any) => a.label === 'org.rideo.provenance').data.asset).toEqual({
      kind: 'stem',
      exportId: done.id,
      stem: 'music',
    });
    expect(manifest.ingredients.length).toBe(cues.length);
    const film = await download(pid, done.media.path, 'export.mp4');
    const measured = parseLoudnorm(
      await ff.run(['-i', film, '-vn', '-af', loudnormFilter('broadcast'), '-f', 'null', '-'], {
        logLevel: 'info',
      }),
    )!;
    expect(Math.abs(measured.inputI - -23)).toBeLessThan(1.5);
    // every frame of the cut is in the export (the mux is bounded by the film's length, not -shortest)
    const probe = await ff.probe(film);
    expect(probe.hasAudio).toBe(true);
    const frames = Math.round(
      Math.max(
        ...(state.docs.timeline as Timeline).tracks.flatMap((tr) =>
          tr.items.map((i) =>
            i.kind === 'text'
              ? i.start + i.duration
              : i.start + (i.out - i.in) / (i.kind === 'video' ? i.speed : 1),
          ),
        ),
      ) * 24,
    );
    expect(Math.round(probe.durationSec! * 24)).toBe(frames);
  }, 600_000);

  it('fails effects with sfx_unavailable without a provider, and validates the cut', async () => {
    const plain = await startStack({ gw: stack.gw, env: { RIDEO_SFX_PROVIDER: 'off' } });
    try {
      const p = await plain.api<{ id: string }>('POST', '/projects', { kind: 'story', title: 'Quiet' });
      await expect(plain.api('POST', `/projects/${p.id}/timeline/effects`)).rejects.toMatchObject({
        status: 422,
        body: { code: 'sfx_unavailable' },
      });
      // nothing to score yet
      await expect(plain.api('POST', `/projects/${p.id}/timeline/score`, {})).rejects.toMatchObject({
        status: 422,
        body: { code: 'validation_error' },
      });
      const config = await plain.api<any>('GET', '/config');
      expect(config.features.sfx).toBeNull();
      expect((await stack.api<any>('GET', '/config')).features.sfx).toEqual({ provider: 'elevenlabs' });
    } finally {
      await plain.stop();
    }
  }, 60_000);
});
