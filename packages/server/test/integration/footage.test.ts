import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Analysis,
  type Job,
  parseProbe,
  posterCommand,
  probeCommand,
  type Resource,
} from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EditorWorker, startEditorWorker } from '../helpers/editor-worker';
import { makeFootage } from '../helpers/media';
import { expectSucceeded, type Stack, startStack } from '../helpers/stack';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

const ffmpeg = (args: string[]) =>
  spawnSync(process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg', ['-y', ...args], { encoding: 'utf8' });

describe('footage → edit workflow', () => {
  let editor: EditorWorker | undefined;
  afterAll(async () => {
    await editor?.stop();
  });

  it('processes an unprobed upload in the editor, analyzes it (signals in the editor, AI on the server), auto-edits and exports', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Footage',
      settings: { resolution: { width: 320, height: 180 } },
    });
    const file = await makeFootage(stack.dataDir);
    const form = new FormData();
    form.set('file', new Blob([await readFile(file)], { type: 'video/mp4' }), 'holiday.mp4');
    const resource = await stack.api<Resource>('POST', `/projects/${p.id}/uploads`, form);
    expect(resource).toMatchObject({ kind: 'video', role: 'source', status: 'processing' });
    const [processJob] = await stack.api<Job[]>('GET', `/projects/${p.id}/jobs?status=queued`);
    expect(processJob).toMatchObject({ kind: 'media.process', lane: 'client' });

    editor = await startEditorWorker(stack, p.id);
    expectSucceeded(await stack.waitJob(p.id, processJob!.id));
    let state = await stack.api<any>('GET', `/projects/${p.id}/state`);
    const media = state.docs.resources[resource.id].media;
    expect(state.docs.resources[resource.id].status).toBe('ready');
    expect(media).toMatchObject({
      width: 320,
      height: 180,
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
    });
    expect(media.durationSec).toBeCloseTo(9, 1);
    expect(media.poster.path).toMatch(/^media\/posters\/.+\.jpg$/);

    expect(
      (await stack.api<any>('POST', `/projects/${p.id}/workflow/approve`, { gate: 'source_ready' })).stage,
    ).toBe('analysis');
    const { analysis, job } = await stack.api<{ analysis: Analysis; job: Job }>(
      'POST',
      `/projects/${p.id}/analyses`,
      { resourceId: resource.id },
    );
    expect(job).toMatchObject({ kind: 'analysis.signals', lane: 'client' });
    const signals = expectSucceeded(await stack.waitJob(p.id, job.id));
    expectSucceeded(await stack.waitJob(p.id, (signals.result as { next: string }).next));
    state = await stack.api<any>('GET', `/projects/${p.id}/state`);
    const a = state.docs.analyses[analysis.id] as Analysis;
    expect(a.status).toBe('completed');
    expect(a.probe?.durationSec).toBeCloseTo(9, 0);
    expect(a.scenes.length).toBeGreaterThanOrEqual(2);
    expect(a.blackSegments[0]).toMatchObject({ start: expect.closeTo(4, 0) });
    expect(a.silences.some((s) => s.end - s.start > 2)).toBe(true);
    expect(a.scenes.some((s) => s.thumbnail?.mime === 'image/jpeg')).toBe(true);
    const kinds = a.suggestions.map((s) => `${s.source}:${s.params.kind}`);
    expect(kinds).toEqual(
      expect.arrayContaining(['rules:cut', 'rules:tighten_silence', 'rules:fade', 'ai:title']),
    );

    const reviewed = await stack.api<Analysis>('PATCH', `/projects/${p.id}/analyses/${a.id}/suggestions`, {
      decisions: a.suggestions.map((s) => ({
        id: s.id,
        status: s.params.kind === 'color' ? 'rejected' : 'accepted',
      })),
    });
    expect(reviewed.suggestions.filter((s) => s.status === 'accepted').length).toBe(a.suggestions.length - 1);
    const edited = await stack.api<any>('POST', `/projects/${p.id}/analyses/${a.id}/auto-edit`);
    const video = edited.timeline.tracks.find((t: { kind: string }) => t.kind === 'video').items;
    expect(video.length).toBe(2);
    expect(video[0].in).toBe(0);
    expect(video[0].out).toBeCloseTo(4, 1);
    expect(video[1].in).toBeGreaterThan(5);
    expect((await stack.api<any>('GET', `/projects/${p.id}/workflow`)).stage).toBe('edit');

    const exp = await stack.api<any>('POST', `/projects/${p.id}/exports`, { quality: 'draft' });
    const done = await stack.waitExport(p.id, exp.export.id);
    expect(done).toMatchObject({ status: 'succeeded', method: 'browser', engine: 'ffmpeg' });
    expect(done.durationSec).toBeGreaterThan(5);
    expect(done.durationSec).toBeLessThan(8);
    const detect = await stack.api<any>('POST', '/watermark/detect', {
      projectId: p.id,
      mediaPath: done.media.path,
    });
    expect(detect).toMatchObject({ found: true, id: done.watermarkId });
  }, 300_000);

  it('takes a browser-probed upload as ready and renders a long timeline in several chunks', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Browser prepared',
      settings: { resolution: { width: 320, height: 180 } },
    });
    const file = await makeFootage(stack.dataDir);
    // What the browser engine does before uploading: probe (banner) and poster, with the shared commands.
    const probe = parseProbe(ffmpeg(probeCommand(file)).stderr)!;
    const poster = join(stack.dataDir, 'poster.jpg');
    expect(ffmpeg(posterCommand(file, poster, probe)).status).toBe(0);
    const form = new FormData();
    form.set('meta', JSON.stringify({ probe, role: 'source' }));
    form.set('file', new Blob([await readFile(file)], { type: 'video/mp4' }), 'src.mp4');
    form.set('poster', new Blob([await readFile(poster)], { type: 'image/jpeg' }), 'poster.jpg');
    const res = await stack.api<Resource>('POST', `/projects/${p.id}/uploads`, form);
    expect(res).toMatchObject({
      status: 'ready',
      media: { durationSec: 9, videoCodec: 'h264', poster: { mime: 'image/jpeg' } },
    });
    expect(await stack.api<Job[]>('GET', `/projects/${p.id}/jobs`)).toEqual([]);

    // six copies of the clip, one crossfade: 54 − 0.5 s → two chunks of the 30 s plan
    const track = (await stack.api<any>('GET', `/projects/${p.id}/timeline`)).tracks[0].id;
    const ops: unknown[] = Array.from({ length: 6 }, () => ({
      op: 'insert',
      trackId: track,
      item: { kind: 'video', source: { type: 'media', media: res.media }, in: 0, out: 9 },
    }));
    const t = await stack.api<any>('POST', `/projects/${p.id}/timeline/ops`, { ops });
    const third = t.timeline.tracks[0].items[2].id;
    await stack.api('POST', `/projects/${p.id}/timeline/ops`, {
      ops: [{ op: 'set_transition', itemId: third, transition: { type: 'crossfade', duration: 0.5 } }],
    });
    const worker = await startEditorWorker(stack, p.id);
    const out = await stack.api<any>('POST', `/projects/${p.id}/exports`, {
      quality: 'standard',
      engine: 'ffmpeg',
    });
    const done = await stack.waitExport(p.id, out.export.id);
    await worker.stop();
    expect(done).toMatchObject({ status: 'succeeded', method: 'browser', engine: 'ffmpeg' });
    expect(done.durationSec).toBeCloseTo(53.5, 0);
    const render = await stack.api<Job>('GET', `/projects/${p.id}/jobs/${out.job.id}`);
    expect(render.staged).toEqual(['part-0001.mp4', 'part-0002.mp4', 'soundtrack.m4a']);
    expect(
      (await stack.api<any>('POST', '/watermark/detect', { projectId: p.id, mediaPath: done.media.path })).id,
    ).toBe(done.watermarkId);
  }, 300_000);
});
