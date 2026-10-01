import { describe, expect, it } from 'vitest';
import {
  AddReferenceInputSchema,
  assembleStoryTimeline,
  ConsentSchema,
  chunkGraph,
  DISCLOSURE_TRACK_ID,
  disclosureFor,
  isRealPersonCharacter,
  missingConsentFields,
  ProjectSettingsPatchSchema,
  ProjectSettingsSchema,
  planChunks,
  realPersonCharacters,
  textItems,
  timelineDuration,
  withDisclosure,
} from '../src';
import * as f from '../src/testing/fixtures';

const actor = { kind: 'user' as const, id: 'u', name: 'You' };
const realPerson = {
  depictsRealPerson: true,
  subject: 'Ada Lovelace',
  grantedBy: 'Ada Lovelace',
  grantedAt: '2026-09-30',
  recordedBy: actor,
  recordedAt: '2026-09-30T10:00:00.000Z',
};

function storyDocs(opts: { real: boolean; label?: 'auto' | 'always' | 'off' }) {
  const mira = f.character({
    name: 'Mira',
    references: [
      f.reference({
        source: 'uploaded',
        consent: opts.real ? realPerson : { ...realPerson, depictsRealPerson: false },
      }),
    ],
  });
  const shot = f.readyShot([mira]);
  const clip = f.clip({ status: 'approved', shots: [shot] });
  const timeline = assembleStoryTimeline({ clips: [clip], fps: 24, width: 320, height: 180 });
  const project = f.project();
  project.settings.disclosure = {
    ...project.settings.disclosure,
    ...(opts.label ? { label: opts.label } : {}),
  };
  return f.docs({ project, characters: f.byId([mira]), clips: f.byId([clip]), timeline });
}

describe('consent records', () => {
  it('lists the fields a real person needs', () => {
    expect(missingConsentFields({ depictsRealPerson: false })).toEqual([]);
    expect(missingConsentFields({ depictsRealPerson: true, subject: 'Ada' })).toEqual([
      'grantedBy',
      'grantedAt',
    ]);
    expect(
      missingConsentFields({
        depictsRealPerson: true,
        subject: ' ',
        grantedBy: 'A',
        grantedAt: '2026-01-01',
      }),
    ).toEqual(['subject']);
  });

  it('validates records and reference inputs', () => {
    expect(ConsentSchema.parse(realPerson).subject).toBe('Ada Lovelace');
    expect(() => ConsentSchema.parse({ depictsRealPerson: true })).toThrow();
    const input = AddReferenceInputSchema.parse({ uri: 'data:x', consent: { depictsRealPerson: false } });
    expect(input.consent).toEqual({ depictsRealPerson: false });
  });

  it('marks characters whose approved likeness is a real person', () => {
    expect(isRealPersonCharacter(f.character({ references: [f.reference({ consent: realPerson })] }))).toBe(
      true,
    );
    expect(
      isRealPersonCharacter(
        f.character({ references: [f.reference({ consent: realPerson, approved: false })] }),
      ),
    ).toBe(false);
    expect(isRealPersonCharacter(f.character())).toBe(false);
  });
});

describe('disclosure rule', () => {
  it('defaults to auto with the AI-generated text', () => {
    const s = ProjectSettingsSchema.parse({});
    expect(s.disclosure).toEqual({ label: 'auto', text: 'AI-generated', position: 'top_right' });
    // a patch never fills in defaults (it is merged over the current settings)
    expect(ProjectSettingsPatchSchema.parse({ disclosure: { text: 'Synthetic' } }).disclosure).toEqual({
      text: 'Synthetic',
    });
  });

  it.each([
    ['auto', false, false, null],
    ['auto', true, true, 'real_person'],
    ['always', false, true, 'policy'],
    ['off', false, false, null],
    ['off', true, true, 'real_person'],
  ] as const)('label %s, real person %s → shown %s (%s)', (label, real, shown, reason) => {
    const docs = storyDocs({ real, label });
    expect(realPersonCharacters(docs).length).toBe(real ? 1 : 0);
    expect(disclosureFor(docs)).toEqual({
      label: shown,
      text: 'AI-generated',
      position: 'top_right',
      reason,
    });
  });
});

describe('withDisclosure', () => {
  it('adds a label track covering the whole film without changing its length', () => {
    const t = storyDocs({ real: false }).timeline!;
    const labelled = withDisclosure(t, { text: 'AI-generated', position: 'bottom_left' });
    expect(withDisclosure(t, null)).toBe(t);
    expect(timelineDuration(labelled)).toBeCloseTo(timelineDuration(t), 6);
    const track = labelled.tracks.find((x) => x.id === DISCLOSURE_TRACK_ID)!;
    expect(track.items).toEqual([
      {
        id: 'itm_disclosure00',
        kind: 'text',
        start: 0,
        duration: timelineDuration(t),
        text: 'AI-generated',
        style: { preset: 'label', position: 'bottom', align: 'left' },
      },
    ]);
    // idempotent: re-labelling replaces the track
    expect(
      withDisclosure(labelled, { text: 'X', position: 'top_right' }).tracks.filter(
        (x) => x.id === DISCLOSURE_TRACK_ID,
      ),
    ).toHaveLength(1);
  });

  it('splits films longer than an hour into hour-long label items', () => {
    const t = storyDocs({ real: false }).timeline!;
    const long = {
      ...t,
      tracks: t.tracks.map((tr) =>
        tr.kind === 'video'
          ? { ...tr, items: tr.items.map((i) => (i.kind === 'video' ? { ...i, out: 5000, in: 0 } : i)) }
          : tr,
      ),
    };
    const items = withDisclosure(long, { text: 'AI', position: 'top_left' }).tracks.find(
      (x) => x.id === DISCLOSURE_TRACK_ID,
    )!.items;
    expect(items.map((i) => [i.start, (i as { duration: number }).duration])).toEqual([
      [0, 3600],
      [3600, 1400],
    ]);
  });

  it('draws the label in a corner in the render plan', () => {
    const t = withDisclosure(storyDocs({ real: true }).timeline!, {
      text: 'AI-generated',
      position: 'top_right',
    });
    expect(textItems(t).some((i) => i.style.preset === 'label')).toBe(true);
    const [chunk] = planChunks(t);
    const g = chunkGraph(t, chunk!, {
      quality: 'standard',
      inputPath: (m) => `/in/${m.hash}`,
      textPath: (i) => `/text/${i}.txt`,
      fontFile: '/fonts/DejaVuSans.ttf',
    });
    const graph = g.args[g.args.indexOf('-filter_complex') + 1]!;
    // 180 px high: fontsize 180/32 ≈ 6, box padding 180/100 ≈ 2, top-right corner with 3% / 4% margins
    expect(graph).toContain(
      'fontsize=6:fontcolor=#ffffff:x=w-text_w-w*0.03:y=h*0.04:box=1:boxcolor=black@0.45:boxborderw=2',
    );
    expect(g.textFiles.map((x) => x.content)).toContain('AI-generated');
  });
});
