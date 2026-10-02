import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type BrandKit, lowerThirdItem, type ProjectBrand, type Timeline } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EditorWorker, startEditorWorker } from '../helpers/editor-worker';
import { ff, makeFootage, makeStill, uploadReady } from '../helpers/media';
import { type ApiError, type Stack, startStack } from '../helpers/stack';

/** Brand kits (docs/design/brand-kits.md): kits and their files, a project's brand, bumpers, lower thirds, the bug. */
let stack: Stack;
let editor: EditorWorker | undefined;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => {
  await editor?.stop();
  await stack?.stop();
});

const FONT = resolve(import.meta.dirname, '../../../web/public/fonts/DejaVuSans.ttf');
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: ApiError) => `${err.status} ${err.body?.code}`,
  );
const upload = async (kitId: string, slot: string, file: string, name: string, type: string) => {
  const form = new FormData();
  form.set('file', new Blob([await readFile(file)], { type }), name);
  return stack.api<BrandKit>('PUT', `/brand-kits/${kitId}/files/${slot}`, form);
};
function colorAt(file: string, t: number, x: number, y: number): number[] {
  const r = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(t),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=6:6:iw*${x}-3:ih*${y}-3,scale=1:1:flags=area`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1024 },
  );
  return [...r.stdout.subarray(0, 3)];
}

describe('brand kits', () => {
  it('keeps kits with validated files, applies one to a project and renders its bug, intro and lower third', async () => {
    // A kit: fonts, a logo, an intro (a 2 s blue video) and an outro still
    const kit = await stack.api<BrandKit>('POST', '/brand-kits', {
      name: 'Northwind',
      colors: { box: '#102030' },
    });
    expect(kit).toMatchObject({
      id: expect.stringMatching(/^bkt_/),
      colors: { box: '#102030', text: '#FFFFFF' },
      bug: { enabled: false },
    });
    expect(kit.lowerThirds).toHaveLength(1);
    let k = await upload(kit.id, 'title_font', FONT, 'DejaVuSans.ttf', 'application/octet-stream');
    expect(k.fonts.title).toMatchObject({
      mime: 'font/ttf',
      file: expect.stringMatching(/^dejavusans-[0-9a-f]{12}\.ttf$/),
    });
    const junk = join(stack.dataDir, 'junk.ttf');
    await writeFile(junk, 'not a font at all');
    expect(await code(upload(kit.id, 'body_font', junk, 'junk.ttf', 'font/ttf'))).toBe(
      '422 validation_error',
    );
    const logo = await makeStill(stack.dataDir, 'logo.png', 'red');
    k = await upload(kit.id, 'logo', logo, 'logo.png', 'image/png');
    expect(k.logo).toMatchObject({ mime: 'image/png', width: 320, height: 180 });
    expect(await code(upload(kit.id, 'logo', FONT, 'x.ttf', 'font/ttf'))).toBe('422 validation_error');
    const intro = join(stack.dataDir, 'intro.mp4');
    await ff.run([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:size=320x180:rate=24:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      intro,
    ]);
    k = await upload(kit.id, 'intro', intro, 'intro.mp4', 'video/mp4');
    expect(k.intro).toMatchObject({ durationSec: expect.closeTo(2, 1), asset: { mime: 'video/mp4' } });
    k = await upload(
      kit.id,
      'outro',
      await makeStill(stack.dataDir, 'outro.png', 'yellow'),
      'outro.png',
      'image/png',
    );
    expect(k.outro).toMatchObject({ durationSec: 3 });
    const file = await fetch(`${stack.url}/api/brand-kits/${kit.id}/files/${k.logo!.file}`);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(await readFile(logo))).toBe(true);
    k = await stack.api<BrandKit>('PATCH', `/brand-kits/${kit.id}`, {
      bug: { enabled: true, corner: 'top_left', size: 0.2, opacity: 1 },
    });
    expect(k.bug).toMatchObject({ enabled: true, corner: 'top_left', size: 0.2, opacity: 1, margin: 0.03 });
    expect((await stack.api<BrandKit[]>('GET', '/brand-kits')).map((x) => x.id)).toContain(kit.id);

    // A project takes the kit: its files become project media
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Branded',
      settings: { resolution: { width: 320, height: 180 }, fps: 24 },
    });
    const footage = await uploadReady(stack, p.id, await makeFootage(stack.dataDir), {
      mime: 'video/mp4',
      name: 'a.mp4',
    });
    const { brand } = await stack.api<{ brand: ProjectBrand }>('PUT', `/projects/${p.id}/brand`, {
      kitId: kit.id,
    });
    expect(brand).toMatchObject({ kitId: kit.id, name: 'Northwind', bug: { corner: 'top_left' } });
    expect(brand.logo!.path).toMatch(/^media\/brand\/logo-[0-9a-f]{12}\.png$/);
    expect(brand.fonts.title!.path).toMatch(/^media\/brand\/dejavusans-[0-9a-f]{12}\.ttf$/);
    expect(brand.fonts.body).toBeNull();
    expect((await fetch(`${stack.url}/api/projects/${p.id}/media/${brand.intro!.media.path}`)).status).toBe(
      200,
    );
    const state = await stack.api<any>('GET', `/projects/${p.id}/state`);
    expect(state.docs.project.settings.brand.kitId).toBe(kit.id);

    // The cut: the footage, a lower third, then the intro in front (the lower third moves with the picture)
    const t0 = await stack.api<Timeline>('GET', `/projects/${p.id}/timeline`);
    await stack.api('POST', `/projects/${p.id}/timeline/ops`, {
      ops: [
        {
          op: 'insert',
          trackId: t0.tracks[0]!.id,
          item: {
            kind: 'video',
            source: { type: 'media', media: footage.media, resourceId: footage.id },
            in: 0,
            out: 3,
          },
        },
        {
          op: 'add_text',
          item: lowerThirdItem(brand, brand.lowerThirds[0]!, {
            name: 'Mira',
            role: 'Keeper',
            start: 0.5,
            duration: 2,
          }),
        },
        {
          op: 'add_bumper',
          position: 'intro',
          source: { type: 'media', media: brand.intro!.media },
          durationSec: brand.intro!.durationSec,
        },
      ],
    });
    const t = await stack.api<Timeline>('GET', `/projects/${p.id}/timeline`);
    expect(t.tracks[0]!.items.map((i) => [i.start, (i as { out: number }).out])).toEqual([
      [0, expect.closeTo(2, 1)],
      [expect.closeTo(2, 1), 3],
    ]);
    expect(t.tracks.find((x) => x.kind === 'text')!.items[0]!.start).toBeCloseTo(2.5, 1);

    // Rendered with the bug: red logo top left over the blue intro, then over the footage
    editor = await startEditorWorker(stack, p.id);
    const exp = await stack.api<any>('POST', `/projects/${p.id}/exports`, {
      quality: 'draft',
      engine: 'ffmpeg',
      bug: true,
    });
    const done = await stack.waitExport(p.id, exp.export.id, 240_000);
    expect(done.status).toBe('succeeded');
    const res = await fetch(`${stack.url}/api/projects/${p.id}/media/${done.media.path}`);
    const out = join(stack.dataDir, 'branded.mp4');
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
    const logoAt = colorAt(out, 1, 0.13, 0.15);
    expect(logoAt[0]! > 150 && logoAt[1]! < 90 && logoAt[2]! < 90).toBe(true);
    const introAt = colorAt(out, 1, 0.6, 0.6);
    expect(introAt[2]! > 150 && introAt[0]! < 90).toBe(true);
    expect(done.durationSec).toBeCloseTo(5, 0);

    // Without the brand
    expect(
      (await stack.api<{ brand: null }>('PUT', `/projects/${p.id}/brand`, { kitId: null })).brand,
    ).toBeNull();
    await stack.api('DELETE', `/brand-kits/${kit.id}`);
    expect(await code(stack.api('GET', `/brand-kits/${kit.id}/files/${k.logo!.file}`))).toBe('404 not_found');
  }, 300_000);

  it('agents list kits and apply one over MCP', async () => {
    const kit = await stack.api<BrandKit>('POST', '/brand-kits', { name: 'Agency' });
    const p = await stack.api<{ id: string }>('POST', '/projects', { kind: 'edit', title: 'Agent brand' });
    const client = new Client({ name: 'Claude Code', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        return { error: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
      };
      expect((await call('brand_kits_list', {})).body.map((x: BrandKit) => x.name)).toContain('Agency');
      const updated = await call('brand_kit_update', { kitId: kit.id, colors: { accent: '#00AA88' } });
      expect(updated.body.colors.accent).toBe('#00AA88');
      const applied = await call('project_brand', { projectId: p.id, kitId: kit.id });
      expect(applied.body).toMatchObject({ kitId: kit.id, name: 'Agency', logo: null });
    } finally {
      await client.close();
    }
  });
});
