import type { Character, Clip, Job, Take } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Dialogue and character voices (docs/design/dialogue.md) against the mock gateway's ElevenLabs endpoints. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => stack?.stop());

async function rejects(p: Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body.code).toBe(code);
    return err as ApiError;
  }
  throw new Error(`expected ${code}`);
}

const state = (pid: string) => stack.api<any>('GET', `/projects/${pid}/state`);

/** Plans and generates the first scene; returns the clip with its takes. */
async function pilot(pid: string, sceneId: string): Promise<Clip> {
  const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, { sceneId, generate: true });
  expectSucceeded(await stack.waitJob(pid, plan.id));
  await stack.waitIdle(pid);
  return Object.values<Clip>((await state(pid)).docs.clips)[0]!;
}

const selected = (clip: Clip) =>
  clip.shots.map((s) => ({ shot: s, take: s.takes.find((t) => t.id === s.selectedTakeId) as Take }));

async function probeHasAudio(pid: string, path: string): Promise<boolean> {
  const res = await fetch(`${stack.url}/api/projects/${pid}/media/${path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // MP4 with an AAC track carries an 'mp4a' sample entry.
  return buf.includes(Buffer.from('mp4a'));
}

describe('voices', () => {
  it('designs, picks and locks a voice; the lock freezes it (V2) and relocking unchanged keeps the version', async () => {
    const p = await stack.api<{ id: string; settings: any }>('POST', '/projects', {
      kind: 'story',
      title: 'Voices',
      brief: { prompt: 'A lighthouse keeper receives letters from the future' },
      settings: { targetDurationSec: 30, pilotDurationSec: 10, resolution: { width: 320, height: 180 } },
    });
    // New projects speak their dialogue when the server has a TTS provider.
    expect(p.settings.dialogue).toEqual({ mode: 'tts', lipSync: true });
    const c = await stack.api<Character>('POST', `/projects/${p.id}/characters`, {
      name: 'Mira',
      voice: { description: 'low and measured, a warm alto with a coastal accent' },
    });
    const job = await stack.api<Job>('POST', `/projects/${p.id}/characters/${c.id}/voice/design`, {});
    expect(job).toMatchObject({ kind: 'voice.design', lane: 'music' });
    expect(expectSucceeded(await stack.waitJob(p.id, job.id)).result).toEqual({ candidates: 3 });
    let mira = (await state(p.id)).docs.characters[c.id];
    expect(mira.voice.candidates).toHaveLength(3);
    for (const cand of mira.voice.candidates) {
      expect(cand.voiceId).toMatch(/^gv\d+x/);
      expect(cand.sample).toMatchObject({ mime: 'audio/mpeg' });
      expect(cand.sample.path).toMatch(/^media\/voices\//);
    }
    await rejects(stack.api('POST', `/projects/${p.id}/characters/${c.id}/voice/lock`), 'validation_error');
    mira = await stack.api<any>('POST', `/projects/${p.id}/characters/${c.id}/voice/select`, {
      candidateId: mira.voice.candidates[1].id,
    });
    expect(mira.voice).toMatchObject({ provider: 'elevenlabs', source: 'designed' });
    // The saved voice keeps the preview's pitch (the mock writes it into the id).
    expect(mira.voice.voiceId.slice(2, mira.voice.voiceId.indexOf('x'))).toBe(
      mira.voice.candidates[1].voiceId.slice(2, mira.voice.candidates[1].voiceId.indexOf('x')),
    );
    expect(mira.voice.sample.hash).toBe(mira.voice.candidates[1].sample.hash);
    mira = await stack.api<any>('POST', `/projects/${p.id}/characters/${c.id}/voice/lock`);
    expect(mira.voice.lock).toMatchObject({ locked: true, version: 1 });
    await rejects(stack.api('POST', `/projects/${p.id}/characters/${c.id}/voice/design`, {}), 'voice_locked');
    await rejects(
      stack.api('POST', `/projects/${p.id}/characters/${c.id}/voice/select`, {
        candidateId: mira.voice.candidates[0].id,
      }),
      'voice_locked',
    );
    await rejects(
      stack.api('PATCH', `/projects/${p.id}/characters/${c.id}`, {
        voice: { description: 'a squeaky tenor' },
      }),
      'voice_locked',
    );
    // The face lock is independent: editing the identity still works while the voice is locked.
    await stack.api('PATCH', `/projects/${p.id}/characters/${c.id}`, { identity: { hair: 'grey braid' } });
    await stack.api('POST', `/projects/${p.id}/characters/${c.id}/voice/unlock`);
    expect(
      (await stack.api<any>('POST', `/projects/${p.id}/characters/${c.id}/voice/lock`)).voice.lock.version,
    ).toBe(1);
  }, 120_000);

  it('clones a recording only with a consent record', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', { kind: 'story', title: 'Clone' });
    const c = await stack.api<Character>('POST', `/projects/${p.id}/characters`, { name: 'Ada' });
    // A 2 s tone at 180 Hz stands in for a recording.
    const { execFileSync } = await import('node:child_process');
    const wav = execFileSync(process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=180:duration=2:sample_rate=16000',
      '-f',
      'wav',
      '-',
    ]);
    const form = (consent?: object) => {
      const f = new FormData();
      f.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'ada.wav');
      if (consent) f.set('consent', JSON.stringify(consent));
      return f;
    };
    await rejects(
      stack.api('POST', `/projects/${p.id}/characters/${c.id}/voice/clone`, form()),
      'consent_required',
    );
    await rejects(
      stack.api(
        'POST',
        `/projects/${p.id}/characters/${c.id}/voice/clone`,
        form({ depictsRealPerson: true }),
      ),
      'consent_required',
    );
    const ada = await stack.api<any>(
      'POST',
      `/projects/${p.id}/characters/${c.id}/voice/clone`,
      form({ depictsRealPerson: true, subject: 'Ada L.', grantedBy: 'Ada L.', grantedAt: '2026-09-30' }),
    );
    expect(ada.voice).toMatchObject({
      source: 'cloned',
      provider: 'elevenlabs',
      consent: { depictsRealPerson: true, subject: 'Ada L.' },
      sample: { mime: 'audio/wav' },
    });
    // The mock estimates the recording's pitch into the cloned voice id.
    expect(Number(/^mv(\d+)x/.exec(ada.voice.voiceId)![1])).toBeGreaterThan(170);
    expect(Number(/^mv(\d+)x/.exec(ada.voice.voiceId)![1])).toBeLessThan(190);
  }, 60_000);
});

describe('dialogue in shots', () => {
  it('speaks every line with its locked voice and conditions the video on the mix (tts)', async () => {
    const { projectId: pid, state: s0 } = await readyStoryProject(stack);
    const scene = s0.docs.screenplay.scenes[0];
    const clip = await pilot(pid, scene.id);
    const s = await state(pid);
    for (const { shot, take } of selected(clip)) {
      expect(take.consistency.status).toBe('passed');
      if (!shot.dialogue.length) {
        expect(take.audio).toBeNull();
        continue;
      }
      const speaker = shot.dialogue[0]!.characterId!;
      expect(take.audio).toMatchObject({
        mode: 'tts',
        lipSync: 'conditioned',
        voiceLocks: { [speaker]: 1 },
        dialogue: { mime: 'audio/wav' },
      });
      expect(take.audio!.dialogue!.path).toMatch(/^media\/dialogue\//);
      expect(take.audio!.lines).toHaveLength(1);
      const line = take.audio!.lines[0]!;
      expect(line).toMatchObject({ characterId: speaker, text: shot.dialogue[0]!.line });
      expect(line.start).toBeGreaterThanOrEqual(0.4);
      expect(line.end).toBeGreaterThan(line.start);
      expect(line.media).toMatchObject({ mime: 'audio/mpeg' });
      expect(take.request.prompt).toContain(
        `${s.docs.characters[speaker].name} says "${shot.dialogue[0]!.line}"`,
      );
      // The model rendered sound from the mix.
      expect(await probeHasAudio(pid, take.video!.path)).toBe(true);
    }
    expect(selected(clip).some(({ take }) => take.audio)).toBe(true);
  }, 300_000);

  it('runs a lip-sync pass when the video model cannot take the mix', async () => {
    const { projectId: pid, state: s0 } = await readyStoryProject(stack, {
      models: { video: 'mock-video-lite-v1' },
    });
    const clip = await pilot(pid, s0.docs.screenplay.scenes[0].id);
    const spoken = selected(clip).filter(({ take }) => take.audio);
    expect(spoken.length).toBeGreaterThan(0);
    for (const { take } of spoken) {
      expect(take.consistency.status).toBe('passed');
      expect(take.audio!.lipSync).toBe('pass');
      // keyframe + video + lip-sync generations
      expect(take.gatewayTaskIds.length).toBeGreaterThanOrEqual(3);
      expect(await probeHasAudio(pid, take.video!.path)).toBe(true);
    }
  }, 300_000);

  it('checks the speakers of native-audio takes against their voices (V4)', async () => {
    const { projectId: pid, state: s0 } = await readyStoryProject(stack, {
      dialogue: { mode: 'native' },
      consistency: { maxAttempts: 2 },
    });
    const clip = await pilot(pid, s0.docs.screenplay.scenes[0].id);
    const spoken = selected(clip).filter(({ shot }) => shot.dialogue.length);
    expect(spoken.length).toBeGreaterThan(0);
    for (const { shot, take } of spoken) {
      expect(take.audio).toMatchObject({ mode: 'native', dialogue: null, lipSync: 'conditioned' });
      expect(take.consistency.status).toBe('passed');
      expect(take.consistency.voices).toEqual([
        { characterId: shot.dialogue[0]!.characterId, present: true, score: 0.93, issues: [] },
      ]);
    }

    // A model without audio input renders its own voice: the speaker check fails every attempt.
    await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { video: 'mock-video-lite-v1' } } });
    const { shot } = spoken[0]!;
    const regen = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`,
    );
    expectSucceeded(await stack.waitJob(pid, regen.id));
    const after = (await state(pid)).docs.clips[clip.id] as Clip;
    const failed = after.shots.find((x) => x.id === shot.id)!.takes.at(-1)!;
    expect(failed.consistency.status).toBe('failed');
    // keyframe + one video per attempt
    expect(failed.gatewayTaskIds).toHaveLength(3);
    expect(failed.consistency.voices[0]!.issues[0]).toMatch(/a different voice/);
  }, 300_000);

  it('requires locked voices (V1) and marks takes stale when a voice is relocked with changes (V6)', async () => {
    const { projectId: pid, state: s0 } = await readyStoryProject(stack);
    const clip = await pilot(pid, s0.docs.screenplay.scenes[0].id);
    const speaker = selected(clip).find(({ take }) => take.audio)!.take.audio!.lines[0]!.characterId!;
    await stack.api('POST', `/projects/${pid}/characters/${speaker}/voice/unlock`);
    await rejects(stack.api('POST', `/projects/${pid}/clips/${clip.id}/generate`), 'voice_not_locked');
    const c = (await state(pid)).docs.characters[speaker];
    const other = c.voice.candidates.find(
      (x: { sample: { hash: string } }) => x.sample.hash !== c.voice.sample.hash,
    );
    await stack.api('POST', `/projects/${pid}/characters/${speaker}/voice/select`, { candidateId: other.id });
    const relocked = await stack.api<any>('POST', `/projects/${pid}/characters/${speaker}/voice/lock`);
    expect(relocked.voice.lock.version).toBe(2);
    const blocked = await rejects(
      stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`),
      'consistency_gate',
    );
    expect(JSON.stringify(blocked.body.errors)).toContain('stale');
    // Regenerating speaks the line with the new voice.
    const shot = selected(clip).find(({ take }) => take.audio)!.shot;
    const regen = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`,
    );
    expectSucceeded(await stack.waitJob(pid, regen.id));
    const take = ((await state(pid)).docs.clips[clip.id] as Clip).shots
      .find((x) => x.id === shot.id)!
      .takes.at(-1)!;
    expect(take.audio!.voiceLocks[speaker]).toBe(2);
  }, 300_000);

  it('assembles a Dialogue track and timed captions, and no voices are needed when dialogue is off', async () => {
    const { projectId: pid, state: s0 } = await readyStoryProject(stack);
    const clip = await pilot(pid, s0.docs.screenplay.scenes[0].id);
    await stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`);
    const { timeline } = await stack.api<any>('POST', `/projects/${pid}/timeline/assemble`, {
      captions: true,
    });
    expect(timeline.tracks.map((t: { name: string }) => t.name)).toEqual([
      'Video',
      'Music',
      'Dialogue',
      'Titles',
    ]);
    const [video, , dialogue, titles] = timeline.tracks;
    const spoken = selected(clip).filter(({ take }) => take.audio?.dialogue);
    expect(dialogue.items).toHaveLength(spoken.length);
    for (const [i, { take }] of spoken.entries()) {
      const item = video.items.find((it: any) => it.source.takeId === take.id);
      expect(item.volume).toBe(0);
      expect(dialogue.items[i]).toMatchObject({
        start: item.start,
        in: 0,
        source: { media: take.audio!.dialogue },
      });
      const caption = titles.items.find((t: any) => t.text.endsWith(take.audio!.lines[0]!.text));
      expect(caption.start).toBeCloseTo(item.start + take.audio!.lines[0]!.start, 3);
    }

    // Dialogue off: the cast gate does not ask for voices and takes have no audio.
    const quiet = await readyStoryProject(stack, { dialogue: { mode: 'off' } });
    const wf = await stack.api<any>('GET', `/projects/${quiet.projectId}/workflow`);
    const cast = wf.stages.find((x: { id: string }) => x.id === 'cast');
    expect(cast.gate.requirements.find((r: { id: string }) => r.id === 'voices.speakingLocked').ok).toBe(
      true,
    );
    expect(Object.values<any>(quiet.state.docs.characters).every((c) => !c.voice?.lock.locked)).toBe(true);
    const qc = await pilot(quiet.projectId, quiet.state.docs.screenplay.scenes[0].id);
    expect(selected(qc).every(({ take }) => take.audio === null)).toBe(true);
  }, 300_000);
});

describe('without a TTS provider', () => {
  it('defaults new projects to no dialogue and explains what is missing', async () => {
    const plain = await startStack({ env: { RIDEO_TTS_PROVIDER: 'off' } });
    try {
      const p = await plain.api<{ id: string; settings: any }>('POST', '/projects', {
        kind: 'story',
        title: 'Silent',
      });
      expect(p.settings.dialogue.mode).toBe('off');
      const c = await plain.api<Character>('POST', `/projects/${p.id}/characters`, { name: 'Mira' });
      const err = await plain
        .api('POST', `/projects/${p.id}/characters/${c.id}/voice/design`, {})
        .catch((e: ApiError) => e);
      expect((err as ApiError).body.code).toBe('tts_unavailable');
    } finally {
      await plain.stop();
    }
  }, 120_000);
});
