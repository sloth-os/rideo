import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clip, Job, Timeline } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfDocument, pdfTextLines } from '../../src/media/pdf';
import { startEditorWorker } from '../helpers/editor-worker';
import { ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** The storyboard stage, the animatic, screenplay import and the shot list (docs/design/storyboard.md). */
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
const clipsOf = async (pid: string) =>
  Object.values<Clip>((await state(pid)).docs.clips).sort((a, b) => a.index - b.index);

/** A ready project with its storyboard drawn (the first scenes planned, a frame per shot). */
async function storyboarded(settings: Record<string, unknown> = {}) {
  const { projectId: pid } = await readyStoryProject(stack, settings);
  const job = await stack.api<Job>('POST', `/projects/${pid}/storyboard/generate`, {});
  const done = expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
  await stack.waitIdle(pid);
  return { pid, result: done.result as { scenes: number; planned: number; frames: number; failed: number } };
}

describe('storyboard', () => {
  it('draws a verified frame per shot of the first scenes, with its dialogue, and gates the pilot', async () => {
    // A 60 s film with a 30 s pilot: the writer drafts two scenes of two shots each.
    const { pid, result } = await storyboarded({
      storyboard: { scenes: 2 },
      targetDurationSec: 60,
      pilotDurationSec: 30,
    });
    const s = await state(pid);
    const scenes = s.docs.screenplay.scenes.slice(0, 2);
    const clips = await clipsOf(pid);
    expect(clips.map((c) => c.sceneId)).toEqual(scenes.map((x: { id: string }) => x.id));
    expect(result).toMatchObject({ scenes: 2, planned: 2, failed: 0 });
    expect(result.frames).toBe(clips.reduce((n, c) => n + c.shots.length, 0));
    for (const shot of clips.flatMap((c) => c.shots)) {
      expect(shot.board).toMatchObject({
        approved: false,
        keyframe: { mime: 'image/png' },
        consistency: { status: 'passed' },
      });
      expect(shot.board!.keyframe.path).toMatch(/^media\/keyframes\//);
      expect(shot.takes).toEqual([]);
      // Speaking shots carry their TTS dialogue for the animatic (docs/design/dialogue.md).
      if (shot.dialogue.some((d) => d.characterId))
        expect(shot.board!.audio).toMatchObject({ mode: 'tts', dialogue: { mime: 'audio/wav' } });
    }
    const wf = await stack.api<any>('GET', `/projects/${pid}/workflow`);
    const gate = wf.stages.find((x: { id: string }) => x.id === 'storyboard').gate;
    expect(gate.requirements[0]).toMatchObject({ id: 'storyboard.approved', ok: false });
    expect(gate.requirements[0].message).toBe(`0 of ${result.frames} storyboard frames approved`);

    // Approving one, then the rest.
    const [first] = clips;
    const approved = await stack.api<Clip>(
      'POST',
      `/projects/${pid}/clips/${first!.id}/shots/${first!.shots[0]!.id}/board/approve`,
      { approved: true },
    );
    expect(approved.shots[0]!.board).toMatchObject({ approved: true, approvedBy: { kind: 'user' } });
    const all = await stack.api<{ approved: number }>('POST', `/projects/${pid}/storyboard/approve-all`);
    expect(all.approved).toBe(result.frames - 1);
    const after = await stack.api<any>('GET', `/projects/${pid}/workflow`);
    expect(after.stages.find((x: { id: string }) => x.id === 'storyboard').gate.satisfied).toBe(true);
  }, 300_000);

  it('makes edited shots outdated and relocked characters stale until the frame is redrawn', async () => {
    const { pid } = await storyboarded({ storyboard: { scenes: 1 } });
    await stack.api('POST', `/projects/${pid}/storyboard/approve-all`);
    let [clip] = await clipsOf(pid);
    const shot = clip!.shots[0]!;
    await stack.api('PATCH', `/projects/${pid}/clips/${clip!.id}/shots/${shot.id}`, {
      description: 'A different opening: the keeper stands at the window.',
    });
    const err = await rejects(
      stack.api('POST', `/projects/${pid}/clips/${clip!.id}/shots/${shot.id}/board/approve`, {
        approved: true,
      }),
      'board_unapprovable',
    );
    expect(err.body.errors).toEqual(['outdated']);
    const wf = await stack.api<any>('GET', `/projects/${pid}/workflow`);
    const req = wf.stages.find((x: { id: string }) => x.id === 'storyboard').gate.requirements[0];
    expect(req.details).toEqual([`c1-s1 (outdated)`]);
    const redraw = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip!.id}/shots/${shot.id}/board/generate`,
    );
    expect(redraw).toMatchObject({ kind: 'shot.board', lane: 'image' });
    expectSucceeded(await stack.waitJob(pid, redraw.id));
    await stack.api('POST', `/projects/${pid}/clips/${clip!.id}/shots/${shot.id}/board/approve`, {
      approved: true,
    });

    // Relocking a character with changes makes its frames stale (R6).
    const character = shot.characterIds[0]!;
    await stack.api('POST', `/projects/${pid}/characters/${character}/unlock`);
    await stack.api('PATCH', `/projects/${pid}/characters/${character}`, {
      identity: { hair: 'silver crop' },
    });
    await stack.api('POST', `/projects/${pid}/characters/${character}/lock`);
    const states = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clip!.id].shots.map(
      (x: { id: string }) => x.id,
    );
    expect(states.length).toBeGreaterThan(0);
    const mcpView = (await stack.api<any>('GET', `/projects/${pid}/workflow`)).stages.find(
      (x: { id: string }) => x.id === 'storyboard',
    ).gate.requirements[0];
    expect(mcpView.ok).toBe(false);
    expect(mcpView.details.join(' ')).toContain('(stale)');
    // storyboard.generate redraws only what needs it.
    const regen = await stack.api<Job>('POST', `/projects/${pid}/storyboard/generate`, {});
    const r = expectSucceeded(await stack.waitJob(pid, regen.id, 180_000)).result as { frames: number };
    [clip] = await clipsOf(pid);
    expect(r.frames).toBe(clip!.shots.filter((x) => x.characterIds.includes(character)).length);
  }, 300_000);

  it('reorders shots, keeping the first a cut and breaking moved continuations', async () => {
    const { pid } = await storyboarded({
      storyboard: { scenes: 1 },
      targetDurationSec: 60,
      pilotDurationSec: 30,
    });
    const [clip] = await clipsOf(pid);
    const ids = [...clip!.shots].sort((a, b) => a.index - b.index).map((s) => s.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const reversed = [...ids].reverse();
    const next = await stack.api<Clip>('POST', `/projects/${pid}/clips/${clip!.id}/shots/reorder`, {
      shotIds: reversed,
    });
    const ordered = [...next.shots].sort((a, b) => a.index - b.index);
    expect(ordered.map((s) => s.id)).toEqual(reversed);
    expect(ordered[0]!.continuity).toBe('cut');
    // Every shot got a new predecessor, so none continues the previous frame any more.
    expect(ordered.every((s) => s.continuity === 'cut')).toBe(true);
    await rejects(
      stack.api('POST', `/projects/${pid}/clips/${clip!.id}/shots/reorder`, { shotIds: reversed.slice(1) }),
      'validation_error',
    );
  }, 300_000);

  it('starts the video pass from approved frames and reuses their dialogue', async () => {
    const { pid } = await storyboarded({ storyboard: { scenes: 1 } });
    await stack.api('POST', `/projects/${pid}/storyboard/approve-all`);
    const [clip] = await clipsOf(pid);
    const gen = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip!.id}/generate`);
    expectSucceeded(await stack.waitJob(pid, gen.id));
    await stack.waitIdle(pid);
    const [done] = await clipsOf(pid);
    for (const shot of done!.shots.filter((s) => s.continuity === 'cut')) {
      const take = shot.takes.find((t) => t.id === shot.selectedTakeId)!;
      expect(take.request.firstFrameSource).toBe('storyboard');
      expect(take.keyframe?.hash).toBe(shot.board!.keyframe.hash);
      expect(take.consistency.status).toBe('passed');
      // only the video generation: the frame is the board's
      expect(take.gatewayTaskIds).toHaveLength(1);
      if (shot.board!.audio) expect(take.audio!.dialogue!.hash).toBe(shot.board!.audio.dialogue!.hash);
    }
  }, 300_000);

  it('builds the animatic of stills, dialogue, temp music and captions, and exports it', async () => {
    const { pid } = await storyboarded({
      storyboard: { scenes: 2 },
      targetDurationSec: 60,
      pilotDurationSec: 30,
    });
    const music = await stack.api<Job>('POST', `/projects/${pid}/music`, {
      prompt: 'temp piano',
      durationSec: 10,
    });
    const musicJob = expectSucceeded(await stack.waitJob(pid, music.id));
    const { animatic } = await stack.api<{ animatic: Timeline }>(
      'POST',
      `/projects/${pid}/storyboard/animatic`,
      {
        musicResourceId: (musicJob.result as { resourceId: string }).resourceId,
      },
    );
    const clips = await clipsOf(pid);
    const shots = clips.flatMap((c) => [...c.shots].sort((a, b) => a.index - b.index));
    expect(animatic.tracks.map((t) => t.name)).toEqual(['Video', 'Music', 'Dialogue', 'Titles']);
    const [video, musicTrack, dialogue, titles] = animatic.tracks;
    expect(video!.items).toHaveLength(shots.length);
    video!.items.forEach((item, i) => {
      const v = item as { source: { media: { hash: string; mime: string } }; out: number; in: number };
      expect(v.source.media.hash).toBe(shots[i]!.board!.keyframe.hash);
      expect(v.source.media.mime).toBe('image/png');
      expect(v.out - v.in).toBeGreaterThanOrEqual(shots[i]!.durationSec);
    });
    expect(musicTrack!.items.length).toBeGreaterThan(0);
    expect(dialogue!.items.length).toBe(shots.filter((s) => s.board?.audio?.dialogue).length);
    expect(titles!.items.length).toBeGreaterThan(0);
    expect((await state(pid)).docs.animatic).toEqual(animatic);

    // The tab renders it like any export (the reference worker runs the same plan with native ffmpeg).
    const editor = await startEditorWorker(stack, pid);
    const exp = await stack.api<any>('POST', `/projects/${pid}/exports`, {
      quality: 'draft',
      source: 'animatic',
    });
    expect(exp.export.source).toBe('animatic');
    expect(exp.job.params.timelinePath).toBe('animatic.json');
    const done = await stack.waitExport(pid, exp.export.id);
    await editor.stop();
    expect(done).toMatchObject({ status: 'succeeded', source: 'animatic' });
    const total = video!.items.reduce(
      (n, i) => n + ((i as { out: number }).out - (i as { in: number }).in),
      0,
    );
    expect(done.durationSec).toBeCloseTo(total, 0);
    // frames, mixes and music are the export's ingredients
    const distinct = new Set(
      animatic.tracks.flatMap((t) => t.items).flatMap((i) => ('source' in i ? [i.source.media.hash] : [])),
    );
    expect(done.contentCredentials.ingredients).toBe(distinct.size);
    const detect = await stack.api<any>('POST', '/watermark/detect', {
      projectId: pid,
      mediaPath: done.media.path,
    });
    expect(detect).toMatchObject({ found: true, id: done.watermarkId });
  }, 300_000);

  it('passes the gate without frames when the storyboard is off', async () => {
    const { projectId: pid } = await readyStoryProject(stack, { storyboard: { enabled: false } });
    const wf = await stack.api<any>('GET', `/projects/${pid}/workflow`);
    expect(wf.stages.find((x: { id: string }) => x.id === 'storyboard').gate.requirements[0]).toMatchObject({
      ok: true,
      message: 'The storyboard is off',
    });
    await rejects(stack.api('POST', `/projects/${pid}/storyboard/animatic`, {}), 'validation_error');
  }, 120_000);
});

describe('shot list', () => {
  it('lists every planned shot as CSV and as a PDF with the frames', async () => {
    const { pid } = await storyboarded({ storyboard: { scenes: 1 } });
    const clips = await clipsOf(pid);
    const shots = clips.flatMap((c) => c.shots);
    const csvRes = await fetch(`${stack.url}/api/projects/${pid}/shotlist.csv`);
    expect(csvRes.headers.get('content-type')).toContain('text/csv');
    expect(csvRes.headers.get('content-disposition')).toContain('shot-list.csv');
    const bytes = Buffer.from(await csvRes.arrayBuffer());
    // UTF-8 BOM so spreadsheet apps read the accents
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = bytes.subarray(3).toString('utf8').trim().split('\r\n');
    expect(rows[0]).toBe(
      'scene,clip,shot,duration_sec,framing,movement,continuity,characters,location,props,description,action,dialogue,board,take',
    );
    expect(rows).toHaveLength(shots.length + 1);
    expect(rows[1]).toContain(',unapproved,none');

    const pdfRes = await fetch(`${stack.url}/api/projects/${pid}/shotlist.pdf`);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
    const pdf = Buffer.from(await pdfRes.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.includes(Buffer.from('/DCTDecode'))).toBe(true);
    const text = (await pdfTextLines(new Uint8Array(pdf))).map((l) => l.text).join('\n');
    expect(text).toContain('Shot list');
    expect(text).toContain('C1 · S1');
  }, 300_000);
});

describe('screenplay import', () => {
  const FOUNTAIN = `Title: The Night Ferry

INT. FERRY CABIN - NIGHT

= Ada finds the ticket.

Rain on the porthole. ADA (40s) counts coins.

ADA
(to herself)
One more crossing.

ELI (O.S.)
Last call for the ferry!

EXT. HARBOUR - DAY

Gulls. Eli coils a rope.

ELI
You came back.

ADA
I never left.
`;

  async function project(title: string) {
    return stack.api<{ id: string }>('POST', '/projects', { kind: 'story', title });
  }

  it('reads Fountain into scenes, draft characters and locations, sized by the page count', async () => {
    const p = await project('Import Fountain');
    const r = await stack.api<any>('POST', `/projects/${p.id}/screenplay/import`, { text: FOUNTAIN });
    expect(r).toMatchObject({ title: 'The Night Ferry', scenes: 2, characters: 2, elements: 2 });
    const s = (await state(p.id)).docs;
    expect(s.screenplay.scenes.map((x: { heading: string }) => x.heading)).toEqual([
      'INT. FERRY CABIN - NIGHT',
      'EXT. HARBOUR - DAY',
    ]);
    const [cabin] = s.screenplay.scenes;
    expect(cabin.summary).toBe('Ada finds the ticket.');
    expect(cabin.dialogue).toEqual([
      expect.objectContaining({ character: 'Ada', line: 'One more crossing.', parenthetical: 'to herself' }),
      expect.objectContaining({ character: 'Eli', line: 'Last call for the ferry!' }),
    ]);
    expect(cabin.dialogue.every((d: { characterId: string | null }) => d.characterId)).toBe(true);
    expect(s.elements[cabin.locationId]).toMatchObject({
      kind: 'location',
      name: 'Ferry Cabin',
      lock: { locked: false },
    });
    const names = Object.values<any>(s.characters).map((c) => [c.name, c.role]);
    expect(names).toEqual(
      expect.arrayContaining([
        ['Ada', 'protagonist'],
        ['Eli', 'minor'],
      ]),
    );
    expect(s.project.settings.targetDurationSec).toBe(r.durationSec);
    expect(s.project.brief.prompt).toBe('Imported screenplay “The Night Ferry”');
    // An existing screenplay is only replaced on request.
    await rejects(stack.api('POST', `/projects/${p.id}/screenplay/import`, { text: FOUNTAIN }), 'conflict');
    await rejects(
      stack.api('POST', `/projects/${p.id}/screenplay/import`, { text: 'No scenes here.', replace: true }),
      'validation_error',
    );
  }, 60_000);

  it('reads Final Draft and PDF uploads', async () => {
    const fdx = `<?xml version="1.0" encoding="UTF-8"?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
    <Paragraph Type="Scene Heading"><Text>INT. KITCHEN - DAY</Text></Paragraph>
    <Paragraph Type="Action"><Text>Steam &amp; smoke.</Text></Paragraph>
    <Paragraph Type="Character"><Text>ANNA</Text></Paragraph>
    <Paragraph Type="Dialogue"><Text>Hello </Text><Text Style="Bold">there.</Text></Paragraph>
  </Content>
  <TitlePage><Content><Paragraph><Text>Kitchen Story</Text></Paragraph></Content></TitlePage>
</FinalDraft>`;
    const p1 = await project('Import FDX');
    const form = new FormData();
    form.set('file', new Blob([fdx], { type: 'application/xml' }), 'kitchen.fdx');
    expect(await stack.api<any>('POST', `/projects/${p1.id}/screenplay/import`, form)).toMatchObject({
      title: 'Kitchen Story',
      scenes: 1,
      characters: 1,
    });
    expect((await state(p1.id)).docs.screenplay.scenes[0].dialogue[0]).toMatchObject({
      character: 'Anna',
      line: 'Hello there.',
    });

    // A screenplay PDF: page numbers, scene numbers and (CONT'D) are page furniture.
    const doc = new PdfDocument().addPage(612, 792);
    let y = 72;
    const at = (x: number, text: string, gap = 0) => {
      doc.text(x, y, text, { size: 12 });
      y += 12 + gap;
    };
    at(108, '1   INT. LIGHTHOUSE LAMP ROOM - NIGHT   1', 12);
    at(108, 'Rain lashes the glass.', 12);
    at(266, 'MIRA');
    at(223, '(breathless)');
    at(180, 'Who keeps sending these?', 12);
    at(108, '2   EXT. HARBOUR ROAD – DAY   2', 12);
    at(108, 'Tom walks.');
    doc.addPage(612, 792);
    y = 72;
    at(540, '2.');
    at(266, 'MIRA (CONT’D)');
    at(180, 'Wait!');
    const dir = await mkdtemp(join(tmpdir(), 'rideo-pdf-'));
    try {
      const pdfPath = join(dir, 'script.pdf');
      await writeFile(pdfPath, doc.toBuffer());
      const p2 = await project('Import PDF');
      const pdfForm = new FormData();
      pdfForm.set(
        'file',
        new Blob([execFileSync('cat', [pdfPath])], { type: 'application/pdf' }),
        'script.pdf',
      );
      expect(await stack.api<any>('POST', `/projects/${p2.id}/screenplay/import`, pdfForm)).toMatchObject({
        scenes: 2,
        characters: 1,
      });
      const scenes = (await state(p2.id)).docs.screenplay.scenes;
      expect(scenes.map((x: { heading: string }) => x.heading)).toEqual([
        'INT. LIGHTHOUSE LAMP ROOM - NIGHT',
        'EXT. HARBOUR ROAD – DAY',
      ]);
      expect(scenes[0].dialogue[0]).toMatchObject({
        line: 'Who keeps sending these?',
        parenthetical: 'breathless',
      });
      expect(scenes[1].dialogue[0]).toMatchObject({ character: 'Mira', line: 'Wait!' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
