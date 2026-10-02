import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Resource, Timeline, VideoItem } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFootage, uploadReady } from '../helpers/media';
import { type ApiError, type Stack, startStack } from '../helpers/stack';

/** NLE interchange (docs/design/interchange.md): the cut out as OTIO, FCPXML, XML and EDL, and back from OTIO. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => stack?.stop());

const get = (path: string) => fetch(`${stack.url}/api${path}`);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: ApiError) => `${err.status} ${err.body?.code}`,
  );

let pid: string;
let footage: string;
let resource: Resource;

describe('NLE interchange', () => {
  beforeAll(async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Harbour cut',
      settings: { resolution: { width: 320, height: 180 }, fps: 24 },
    });
    pid = p.id;
    footage = await makeFootage(stack.dataDir);
    resource = await uploadReady(stack, pid, footage, { mime: 'video/mp4', name: 'harbour.mp4' });
    const timeline = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    const video = timeline.tracks.find((t) => t.kind === 'video')!.id;
    const music = timeline.tracks.find((t) => t.kind === 'audio')!.id;
    const source = { type: 'media', media: resource.media, resourceId: resource.id };
    await stack.api('POST', `/projects/${pid}/timeline/ops`, {
      ops: [
        { op: 'insert', trackId: video, item: { kind: 'video', source, in: 0, out: 3 } },
        { op: 'insert', trackId: video, item: { kind: 'video', source, in: 5, out: 8, label: 'Fractal' } },
        { op: 'insert', trackId: music, item: { kind: 'audio', source, start: 1, in: 0, out: 2 } },
        {
          op: 'add_text',
          item: { kind: 'text', start: 0, duration: 2, text: 'Harbour', style: { preset: 'title' } },
        },
      ],
    });
    const t = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    const second = t.tracks.find((x) => x.kind === 'video')!.items[1]!.id;
    await stack.api('POST', `/projects/${pid}/timeline/ops`, {
      ops: [
        { op: 'set_speed', itemId: second, speed: 2 },
        { op: 'set_transition', itemId: second, transition: { type: 'crossfade', duration: 0.5 } },
      ],
    });
  }, 120_000);

  it('hands the cut off in four formats whose clips are the originals on WebDAV', async () => {
    const base = `${stack.url}/dav/rideo`;
    const res = await get(`/projects/${pid}/interchange.otio?mediaBase=${encodeURIComponent(base)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="harbour-cut.otio"');
    const otio: any = await res.json();
    const [picture, sound, musicTrack] = otio.tracks.children;
    expect(otio.tracks.children.map((t: any) => t.name)).toEqual(['Video', 'Production sound', 'Music']);
    expect(picture.children.map((c: any) => c.OTIO_SCHEMA)).toEqual(['Clip.1', 'Transition.1', 'Clip.1']);
    expect(sound.metadata.rideo.linked).toBe(true);
    expect(musicTrack.children.map((c: any) => c.OTIO_SCHEMA)).toEqual(['Gap.1', 'Clip.1']);
    expect(picture.children[2].effects[0].time_scalar).toBe(2);
    expect(otio.tracks.markers[0].name).toBe('Harbour');
    // The URL is the original file on WebDAV, byte for byte
    const url = picture.children[0].media_reference.target_url;
    expect(url).toBe(`${base}/projects/${pid}/${resource.media.path}`);
    const original = await fetch(url);
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer()).equals(await readFile(footage))).toBe(true);

    // Defaults to the WebDAV root the server knows; mounted paths become file URLs
    const config = await stack.api<any>('GET', '/config');
    expect(config.features.interchange.mediaBase).toMatch(/\/dav\/rideo$/);
    const fcpxml = await (await get(`/projects/${pid}/interchange.fcpxml`)).text();
    expect(fcpxml).toContain(
      `src="${config.features.interchange.mediaBase}/projects/${pid}/${resource.media.path}"`,
    );
    expect(fcpxml).toContain('<transition name="Cross Dissolve"');
    expect(fcpxml).toContain('<title ref=');
    const xml = await (await get(`/projects/${pid}/interchange.xml?mediaBase=/Volumes/dav/rideo`)).text();
    expect(xml).toContain(
      `<pathurl>file:///Volumes/dav/rideo/projects/${pid}/${resource.media.path}</pathurl>`,
    );
    expect(xml).toContain('<effectid>timeremap</effectid>');
    const edl = await get(`/projects/${pid}/interchange.edl?mediaBase=/Volumes/dav/rideo`);
    expect(edl.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = await edl.text();
    expect(text.split('\n').slice(0, 4)).toEqual([
      'TITLE: Harbour cut',
      'FCM: NON-DROP FRAME',
      '',
      '001  AX       B     C        00:00:00:00 00:00:02:12 01:00:00:00 01:00:02:12',
    ]);
    expect(text).toContain('002  AX       B     D    012 00:00:05:00 00:00:08:00 01:00:02:12 01:00:04:00');
    expect(text).toContain('M2   AX       048.0                00:00:05:00');

    // Nothing to hand off: an empty animatic
    expect((await get(`/projects/${pid}/interchange.otio?source=animatic`)).status).toBe(409);
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_interchange_total\{direction="export",format="otio"\} 1/);
  });

  it('takes a re-edited cut back from OTIO in one commit', async () => {
    const otio: any = await (await get(`/projects/${pid}/interchange.otio`)).json();
    const before = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    // The editor swapped the two shots, trimmed one, and added a clip the project does not have
    const picture = otio.tracks.children[0];
    const [first, , second] = picture.children;
    first.source_range.duration.value = 48; // 2 s instead of 2.5 s
    const stranger = structuredClone(first);
    stranger.name = 'B-roll from the NLE';
    stranger.metadata = {};
    stranger.media_reference.target_url = 'file:///Volumes/Media/broll.mov';
    picture.children = [second, first, stranger];
    otio.name = 'Harbour cut v2';
    const res = await stack.api<any>('POST', `/projects/${pid}/interchange/import`, otio);
    expect(res).toMatchObject({
      clips: 3,
      unresolved: [{ name: 'B-roll from the NLE', url: 'file:///Volumes/Media/broll.mov' }],
      skipped: [],
    });
    expect(res.commit.message).toBe('Import “Harbour cut v2” from OTIO (3 clips)');
    const after = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    const items = after.tracks.find((t) => t.kind === 'video')!.items as VideoItem[];
    const old = before.tracks.find((t) => t.kind === 'video')!.items as VideoItem[];
    expect(items.map((i) => [i.id, i.in, i.out, i.speed, i.start])).toEqual([
      [old[1]!.id, 5, 8, 2, 0],
      [old[0]!.id, 0, 2, 1, 1.5],
    ]);
    expect(after.tracks.find((t) => t.kind === 'audio')!.items).toHaveLength(1);
    expect(after.tracks.find((t) => t.kind === 'text')!.items.map((i: any) => i.text)).toEqual(['Harbour']);

    // A multipart .otio file works the same; bad files are refused
    const form = new FormData();
    form.set('file', new Blob([JSON.stringify(otio)], { type: 'application/json' }), 'cut.otio');
    expect((await stack.api<any>('POST', `/projects/${pid}/interchange/import`, form)).clips).toBe(3);
    expect(
      await code(stack.api('POST', `/projects/${pid}/interchange/import`, { OTIO_SCHEMA: 'Clip.1' })),
    ).toBe('422 validation_error');
    const junk = new FormData();
    junk.set('file', new Blob(['not json']), 'cut.otio');
    expect(await code(stack.api('POST', `/projects/${pid}/interchange/import`, junk))).toBe(
      '422 validation_error',
    );
    const foreign = structuredClone(otio);
    foreign.tracks.children[0].children = [stranger];
    foreign.tracks.children.splice(1);
    expect(await code(stack.api('POST', `/projects/${pid}/interchange/import`, foreign))).toBe(
      '422 validation_error',
    );

    // History restores the cut from before
    const log = await stack.api<any[]>('GET', `/projects/${pid}/history?path=timeline.json&limit=3`);
    expect(log[0].message).toBe('Import “Harbour cut v2” from OTIO (3 clips)');
  });

  it('agents hand off and take back cuts over MCP', async () => {
    const client = new Client({ name: 'Claude Code', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`));
    await client.connect(transport);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        return { error: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
      };
      const edl = await call('interchange_export', {
        projectId: pid,
        format: 'edl',
        mediaBase: 'file:///mnt/rideo',
      });
      expect(edl.body).toMatchObject({ filename: 'harbour-cut.edl', mime: 'text/plain' });
      expect(edl.body.content).toContain(
        `* SOURCE URL: file:///mnt/rideo/projects/${pid}/${resource.media.path}`,
      );
      const otio = await call('interchange_export', { projectId: pid, format: 'otio' });
      const back = await call('interchange_import', { projectId: pid, otio: otio.body.content });
      expect(back).toMatchObject({ error: false, body: { clips: 3, unresolved: [] } });
      const bad = await call('interchange_import', { projectId: pid, otio: '{' });
      expect(bad).toMatchObject({ error: true, body: { code: 'validation_error' } });
    } finally {
      await client.close();
    }
  });
});
