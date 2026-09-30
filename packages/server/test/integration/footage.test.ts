import { readFile } from 'node:fs/promises';
import type { Analysis, Job, Resource } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFootage } from '../helpers/media';
import { expectSucceeded, type Stack, startStack } from '../helpers/stack';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

describe('footage → edit workflow', () => {
  it('uploads, analyzes, suggests, auto-edits and exports a watermarked cut', async () => {
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
    await stack.waitIdle(p.id);
    let state = await stack.api<any>('GET', `/projects/${p.id}/state`);
    expect(state.docs.resources[resource.id].status).toBe('ready');
    expect(state.docs.resources[resource.id].media.proxy.path).toMatch(/^media\/proxies\/.+\.webm$/);

    expect(
      (await stack.api<any>('POST', `/projects/${p.id}/workflow/approve`, { gate: 'source_ready' })).stage,
    ).toBe('analysis');
    const { analysis, job } = await stack.api<{ analysis: Analysis; job: Job }>(
      'POST',
      `/projects/${p.id}/analyses`,
      { resourceId: resource.id },
    );
    expectSucceeded(await stack.waitJob(p.id, job.id));
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
    expectSucceeded(await stack.waitJob(p.id, exp.job.id));
    const [done] = await stack.api<any[]>('GET', `/projects/${p.id}/exports`);
    expect(done.durationSec).toBeGreaterThan(5);
    expect(done.durationSec).toBeLessThan(8);
    const detect = await stack.api<any>('POST', '/watermark/detect', {
      projectId: p.id,
      mediaPath: done.media.path,
    });
    expect(detect.found).toBe(true);
  }, 300_000);

  it('finishes browser (WebCodecs) uploads with the server-side watermark', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Browser export',
      settings: { resolution: { width: 320, height: 180 } },
    });
    const file = await makeFootage(stack.dataDir);
    const upload = new FormData();
    upload.set('file', new Blob([await readFile(file)], { type: 'video/mp4' }), 'src.mp4');
    const res = await stack.api<Resource>('POST', `/projects/${p.id}/uploads`, upload);
    await stack.waitIdle(p.id);
    const state = await stack.api<any>('GET', `/projects/${p.id}/state`);
    const media = state.docs.resources[res.id].media;
    const track =
      state.docs.timeline?.tracks?.[0]?.id ??
      (await stack.api<any>('GET', `/projects/${p.id}/timeline`)).tracks[0].id;
    await stack.api('POST', `/projects/${p.id}/timeline/ops`, {
      ops: [
        {
          op: 'insert',
          trackId: track,
          item: { kind: 'video', source: { type: 'media', media }, in: 0, out: 3 },
        },
      ],
    });
    const form = new FormData();
    form.set('meta', JSON.stringify({ codec: 'vp09.00.10.08', width: 320, height: 180, durationSec: 3 }));
    form.set('file', new Blob([await readFile(file)], { type: 'video/mp4' }), 'browser-export.mp4');
    const out = await stack.api<any>('POST', `/projects/${p.id}/exports/upload`, form);
    expect(out.export.method).toBe('browser');
    expectSucceeded(await stack.waitJob(p.id, out.job.id));
    const [done] = await stack.api<any[]>('GET', `/projects/${p.id}/exports`);
    expect(done).toMatchObject({ status: 'succeeded', method: 'browser' });
    expect(
      (await stack.api<any>('POST', '/watermark/detect', { projectId: p.id, mediaPath: done.media.path })).id,
    ).toBe(done.watermarkId);
  }, 300_000);
});
