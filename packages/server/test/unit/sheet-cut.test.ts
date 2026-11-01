import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cutSheet, gutterSpans } from '../../src/media/sheet';
import { ff } from '../helpers/media';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function tmp() {
  const dir = await mkdtemp(join(tmpdir(), 'rideo-sheet-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The mean colour of an image. */
async function meanColour(file: string, dir: string): Promise<[number, number, number]> {
  const out = join(dir, `mean-${Math.random().toString(36).slice(2)}.rgb`);
  await ff.run([
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'scale=1:1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    out,
  ]);
  const px = await readFile(out);
  return [px[0]!, px[1]!, px[2]!];
}

const dominant = ([r, g, b]: [number, number, number]) =>
  r > g && r > b ? 'red' : g > r && g > b ? 'green' : 'blue';

describe('scene sheets cut into panels (docs/design/storyboard.md#scene-sheets)', () => {
  it('finds the panels between the gutters, and equal cells when there are none', () => {
    const profile = [1, 1, 0.2, 0.3, 0.1, 1, 0.95, 0.4, 0.2, 0.3, 1, 1];
    expect(gutterSpans(profile, 2)).toEqual({
      found: true,
      spans: [
        [2, 5],
        [7, 10],
      ],
    });
    // A speck of colour in a gutter is not a panel
    expect(gutterSpans([1, 0.2, 0.2, 0.2, 1, 0.5, 1, 0.2, 0.2, 0.2, 1], 2).found).toBe(true);
    expect(gutterSpans(new Array(12).fill(0.1), 3)).toEqual({
      found: false,
      spans: [
        [0, 4],
        [4, 8],
        [8, 12],
      ],
    });
  });

  it("cuts each shot's panel, inside its edges and to the frame's shape, from a drawn sheet", async () => {
    const dir = await tmp();
    const sheet = join(dir, 'sheet.png');
    // Two columns and two rows of 460×250 panels with 20 px white gutters; a white cloud in the first panel
    await ff.run([
      '-f',
      'lavfi',
      '-i',
      'color=c=white:s=980x560',
      '-frames:v',
      '1',
      '-vf',
      [
        'drawbox=x=20:y=20:w=460:h=250:color=red:t=fill',
        'drawbox=x=500:y=20:w=460:h=250:color=green:t=fill',
        'drawbox=x=20:y=290:w=460:h=250:color=blue:t=fill',
        'drawbox=x=500:y=290:w=460:h=250:color=0x808080:t=fill',
        'drawbox=x=40:y=30:w=200:h=60:color=white:t=fill',
      ].join(','),
      sheet,
    ]);
    const cut = await cutSheet(ff, sheet, { columns: 2, rows: 2, panels: 3 }, { width: 16, height: 9 }, dir);
    expect(cut.gutters).toBe(true);
    expect(cut.files).toHaveLength(3);
    const colours = [];
    for (const file of cut.files) {
      const probe = await ff.probe(file);
      // 250 px high at most, and 16:9 from the panel's middle
      expect(probe.height).toBeLessThanOrEqual(250);
      expect(probe.width! / probe.height!).toBeCloseTo(16 / 9, 1);
      const colour = await meanColour(file, dir);
      // No gutter white along an edge
      expect(Math.min(...colour)).toBeLessThan(200);
      colours.push(dominant(colour));
    }
    expect(colours).toEqual(['red', 'green', 'blue']);
  });

  it('cuts equal cells from a sheet drawn without gutters', async () => {
    const dir = await tmp();
    const sheet = join(dir, 'plain.png');
    await ff.run([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=640x720',
      '-frames:v',
      '1',
      '-vf',
      'drawbox=x=0:y=360:w=640:h=360:color=blue:t=fill',
      sheet,
    ]);
    const cut = await cutSheet(ff, sheet, { columns: 1, rows: 2, panels: 2 }, { width: 16, height: 9 }, dir);
    expect(cut.gutters).toBe(false);
    expect(await Promise.all(cut.files.map(async (f) => dominant(await meanColour(f, dir))))).toEqual([
      'red',
      'blue',
    ]);
  });
});
