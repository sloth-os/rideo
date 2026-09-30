import { describe, expect, it } from 'vitest';
import {
  BASE_NEGATIVE,
  clampDuration,
  compileKeyframeRequest,
  compileReferenceRequest,
  compileShotPrompt,
  compileVideoRequest,
  identityFragment,
  ProjectSettingsSchema,
  selectReferences,
  shotSeed,
} from '../src';
import * as f from '../src/testing/fixtures';

const settings = ProjectSettingsSchema.parse({ resolution: { width: 320, height: 180 } });

describe('prompt compiler (R3)', () => {
  it('renders identities in a fixed field order', () => {
    const mira = f.character();
    const text = identityFragment(mira);
    expect(text).toBe(
      'Mira: early 30s woman, East Asian, slender athletic build; face: oval face, high cheekbones, small scar through left eyebrow; hair: jet-black straight bob with blunt fringe; eyes: dark brown almond eyes; skin: light olive. Wearing: charcoal field jacket over a white t-shirt.',
    );
    expect(identityFragment(structuredClone(mira))).toBe(text);
  });

  it('is deterministic and embeds every character in shot order', () => {
    const mira = f.character();
    const jonah = f.character({ name: 'Jonah' });
    const shot = f.shot({ characterIds: [jonah.id, mira.id] });
    const ctx = { shot, characters: [jonah, mira], screenplay: f.screenplay(), settings };
    const p1 = compileShotPrompt(ctx, 'video');
    expect(p1).toBe(compileShotPrompt(ctx, 'video'));
    expect(p1.indexOf('Jonah:')).toBeLessThan(p1.indexOf('Mira:'));
    expect(p1).toContain('visual style: neo-noir, 35mm film grain');
    expect(p1).toContain('Action: She climbs, breathing hard.');
    expect(compileShotPrompt(ctx, 'keyframe')).not.toContain('Action:');
  });

  it('keeps identities when the prompt is overridden', () => {
    const mira = f.character();
    const shot = f.shot({ characterIds: [mira.id], promptOverride: 'Mira reads the letter by candlelight' });
    const p = compileShotPrompt({ shot, characters: [mira], screenplay: null, settings }, 'keyframe');
    expect(p).toContain('Mira reads the letter by candlelight.');
    expect(p).toContain('Mira: early 30s woman');
  });

  it('selects references by wardrobe then view, within the model budget', () => {
    const mira = f.character();
    const w2 = { id: mira.wardrobe[0]!.id.replace('wdr', 'wdr'), name: 'x', description: 'x' };
    mira.references = [
      f.reference({ view: 'profile' }),
      f.reference({ view: 'front', approved: false }),
      f.reference({ view: 'three_quarter' }),
      f.reference({ view: 'front', wardrobeId: 'wdr_0000000000other' }),
    ];
    void w2;
    const sel = selectReferences([mira], f.shot(), 4);
    expect(sel.needsSheet).toBe(false);
    expect(sel.perCharacter[0]!.refs.map((r) => r.view)).toEqual(['three_quarter', 'profile']);
    const crowd = [f.character(), f.character(), f.character()];
    expect(selectReferences(crowd, f.shot(), 2).needsSheet).toBe(true);
    expect(selectReferences(crowd, f.shot(), 6).perCharacter.every((p) => p.refs.length === 1)).toBe(true);
  });

  it('compiles keyframe and video requests with stable seeds and model limits', () => {
    const mira = f.character();
    const shot = f.shot({ characterIds: [mira.id], durationSec: 14 });
    const ctx = { shot, characters: [mira], screenplay: f.screenplay(), settings };
    const kf = compileKeyframeRequest(ctx, { referenceUris: ['data:a', 'data:b'], attempt: 0 });
    expect(kf.model).toBeUndefined();
    expect(kf.input).toHaveLength(3);
    expect(kf.parameters?.negative_prompt).toBe(BASE_NEGATIVE);
    expect(kf.parameters?.seed).toBe(shotSeed(shot, [mira], 0));
    expect(compileKeyframeRequest(ctx, { referenceUris: [], attempt: 1 }).parameters?.seed).not.toBe(
      kf.parameters?.seed,
    );
    const video = compileVideoRequest(ctx, {
      firstFrameUri: 'data:kf',
      referenceUris: ['data:a'],
      attempt: 0,
      model: 'mock-video-v1',
      limits: { max_duration_seconds: 10, min_duration_seconds: 2, supports_reference_image: false },
    });
    expect(video.model).toBe('mock-video-v1');
    expect(video.parameters?.duration_seconds).toBe(10);
    expect(video.input.map((p) => ('role' in p ? p.role : p.type))).toEqual(['text', 'first_frame']);
    expect(clampDuration(1, null)).toBe(4);
  });

  it('builds reference sheet requests', () => {
    const mira = f.character();
    const req = compileReferenceRequest(mira, 'profile', {
      screenplay: f.screenplay(),
      settings,
      baseImageUri: 'data:x',
    });
    expect((req.input[0] as { text: string }).text).toContain('side profile view');
    expect(req.input).toHaveLength(2);
    expect(req.parameters?.dimensions).toEqual({ width: 320, height: 320 });
  });
});
