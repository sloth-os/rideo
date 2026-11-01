import { describe, expect, it } from 'vitest';
import {
  compileSheetPrompt,
  compileSheetRequest,
  DEFAULT_SHEET_PIXELS,
  drawnOnSheet,
  ProjectSettingsPatchSchema,
  ProjectSettingsSchema,
  SHEET_MAX_PANELS,
  SHEET_PROMPT_PREFIX,
  type ShotContext,
  sheetLayout,
  shotContextOf,
} from '../src';
import * as f from '../src/testing/fixtures';

const HD = { width: 1920, height: 1080 };

describe('scene sheets (docs/design/storyboard.md#scene-sheets)', () => {
  it('lays a sheet out nearest square, without a whole empty row, as large as the model draws', () => {
    const grid = (n: number, frame = HD) => {
      const l = sheetLayout(n, frame);
      return `${l.columns}x${l.rows}`;
    };
    expect([2, 3, 4, 5, 6, 7, 8].map((n) => grid(n))).toEqual([
      '1x2',
      '1x3',
      '2x2',
      '2x3',
      '2x3',
      '2x4',
      '2x4',
    ]);
    // Upright frames sit side by side
    expect(grid(6, { width: 1080, height: 1920 })).toBe('3x2');
    expect(grid(9)).toBe(grid(SHEET_MAX_PANELS));
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      const l = sheetLayout(n, HD);
      expect(l.width * l.height).toBeLessThanOrEqual(DEFAULT_SHEET_PIXELS);
      expect(l.width % 16).toBe(0);
      expect(l.height % 16).toBe(0);
      // Its cells are the frame's shape, give or take the rounding
      expect((l.width / l.columns / (l.height / l.rows)) * (9 / 16)).toBeCloseTo(1, 1);
    }
    expect(sheetLayout(6, HD, 2_000_000).width * sheetLayout(6, HD, 2_000_000).height).toBeLessThanOrEqual(
      2_000_000,
    );
  });

  it('is off in the schema, and a person or an agent can turn it on', () => {
    expect(ProjectSettingsSchema.parse({}).storyboard).toMatchObject({
      sheet: false,
      sheetPixels: DEFAULT_SHEET_PIXELS,
    });
    expect(
      ProjectSettingsPatchSchema.parse({ storyboard: { sheet: true, sheetPixels: 2_000_000 } }).storyboard,
    ).toEqual({ sheet: true, sheetPixels: 2_000_000 });
    expect(() => ProjectSettingsPatchSchema.parse({ storyboard: { sheetPixels: 100 } })).toThrow();
  });

  it('draws a scene on one sheet when it is drawn whole and fits one, and alone otherwise', () => {
    const clip = (n: number) => ({ shots: Array.from({ length: n }, (_, i) => ({ id: `s${i}` })) });
    const all = (n: number) => clip(n).shots.map((s) => s.id);
    expect(drawnOnSheet(clip(2), all(2))).toBe(true);
    expect(drawnOnSheet(clip(SHEET_MAX_PANELS), all(SHEET_MAX_PANELS))).toBe(true);
    // Two sheets of one scene disagree: a longer scene is drawn alone
    expect(drawnOnSheet(clip(SHEET_MAX_PANELS + 1), all(SHEET_MAX_PANELS + 1))).toBe(false);
    // A scene with frames kept, and a single frame
    expect(drawnOnSheet(clip(4), all(4).slice(1))).toBe(false);
    expect(drawnOnSheet(clip(1), all(1))).toBe(false);
  });

  describe('the prompt', () => {
    const sammy = f.character({ name: 'Sammy' });
    const rosie = f.character({ name: 'Rosie' });
    const kite = f.element({ kind: 'prop', name: 'Big Red Kite' });
    const sandwich = f.element({ kind: 'prop', name: 'Big Sandwich' });
    const hill = f.element({ kind: 'location', name: 'Green Hill' });
    const contexts = (): ShotContext[] => {
      const a = f.shot({
        index: 0,
        description: 'Sammy walks up the path with the kite under his arm',
        characterIds: [sammy.id, rosie.id],
        elementIds: [hill.id, kite.id],
        camera: { ...f.shot().camera, framing: 'wide' },
      });
      const b = f.shot({
        index: 1,
        description: 'Rosie holds the round handle in both paws',
        characterIds: [rosie.id],
        elementIds: [hill.id],
        camera: { ...f.shot().camera, framing: 'close_up' },
      });
      const scene = {
        ...f.screenplay().scenes[0]!,
        id: 'scn_0000000000aaaaaa',
        location: 'Green Hill',
        timeOfDay: 'afternoon',
        continuity: 'Windy from the left. The big sandwich is inside the closed backpack.',
      };
      const clip = f.clip({ sceneId: scene.id, shots: [a, b] });
      const docs = f.docs({
        project: f.project({ settings: ProjectSettingsSchema.parse({ generation: { promptVersion: 3 } }) }),
        screenplay: f.screenplay({ scenes: [scene] }),
        characters: f.byId([sammy, rosie]),
        elements: f.byId([kite, sandwich, hill]),
        clips: { [clip.id]: clip },
      });
      return [shotContextOf(a, docs, clip), shotContextOf(b, docs, clip)];
    };

    it('says the grid, the scene once, each panel as its frame would, and the cast once', () => {
      const ctxs = contexts();
      const text = compileSheetPrompt(ctxs, sheetLayout(2, HD), { referenceLabels: ['Sammy', 'Rosie'] });
      expect(text.startsWith(`${SHEET_PROMPT_PREFIX} two panels in one column and two rows`)).toBe(true);
      expect(text.match(/Scene: /g)).toHaveLength(1);
      expect(text).toContain('Windy from the left');
      // No shot shows the sandwich
      expect(text).not.toMatch(/sandwich/i);
      const one = text.indexOf('Panel 1: Sammy walks up the path');
      const two = text.indexOf('Panel 2: Rosie holds the round handle');
      expect(one).toBeGreaterThan(0);
      expect(two).toBeGreaterThan(one);
      // Each panel says its own framing and who is in it
      expect(text.slice(one, two)).toContain('wide shot');
      expect(text.slice(two)).toMatch(/close-up/);
      expect(text.slice(two)).toContain('In frame: only Rosie');
      expect(text.match(/Characters \(keep identities/g)).toHaveLength(1);
      expect(text).toContain('Reference images, in order: 1 Sammy; 2 Rosie.');
      expect(text).toContain('No text, numbers, captions or speech bubbles in the panels.');
    });

    it('fills a cell no shot fills with the place alone, and asks for the layout canvas', () => {
      const ctxs = contexts();
      const five = [...ctxs, ...ctxs, ctxs[0]!];
      const layout = sheetLayout(5, HD);
      const text = compileSheetPrompt(five, layout);
      expect(text).toContain('A storyboard sheet of six panels in two columns and three rows');
      expect(text).toContain('Panel 6: the same place, with no one in it.');
      const req = compileSheetRequest(five, layout, { referenceUris: ['data:a', 'data:b'], attempt: 0 });
      expect(req.parameters?.dimensions).toEqual({ width: layout.width, height: layout.height });
      expect(req.input.filter((p) => p.type === 'image')).toHaveLength(2);
      // A sheet drawn again says what each panel that failed its check must show
      const again = compileSheetPrompt(ctxs, sheetLayout(2, HD), {
        correction: 'in panel 2, Rosie holds the handle in both paws;',
      });
      expect(again).toContain('Make sure: in panel 2, Rosie holds the handle in both paws.');
      expect(compileSheetPrompt(ctxs, sheetLayout(2, HD), { correction: ' ' })).not.toContain('Make sure');
    });
  });
});
