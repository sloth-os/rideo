import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmRequest } from '../../src/ai/llm';
import { LlmTasks } from '../../src/ai/tasks';
import { VisionLlmJudge } from '../../src/consistency/judge';

class ScriptedVision implements LlmAdapter {
  readonly provider = 'fake';
  readonly model = 'vision-1';
  calls: LlmRequest[] = [];
  constructor(private readonly answer: object) {}
  async complete(r: LlmRequest) {
    this.calls.push(r);
    return { text: JSON.stringify(this.answer) };
  }
}

describe('the vision judge (docs/design/continuity.md#quality-checks-in-the-gate)', () => {
  it('is told who must not be in the frame, and counts only those names as extras', async () => {
    const vision = new ScriptedVision({
      frames: [
        {
          index: 0,
          characters: [{ characterId: 'chr_rosie', present: true, identityScore: 0.9, issues: [] }],
          physics: { score: 0.9, issues: [] },
          extras: ['sammy', 'Bao'],
          others: ['a fox in the background'],
          duplicates: ['a second beach ball'],
        },
      ],
    });
    const judge = new VisionLlmJudge(new LlmTasks(vision, vision));
    const out = await judge.judge({
      characters: [{ id: 'chr_rosie', name: 'Rosie', identity: 'a small plush panda', references: [] }],
      frames: [Buffer.from('png')],
      shotDescription: 'Rosie points at the chart',
      qualityChecks: true,
      absent: [{ name: 'Sammy', look: 'a bigger plush panda in a blue jacket' }],
    });
    expect(out.quality).toEqual([
      {
        physics: { score: 0.9, issues: [] },
        extras: ['Sammy'],
        others: ['a fox in the background'],
        duplicates: ['a second beach ball'],
      },
    ]);
    // It is asked about anything shown twice (docs/design/continuity.md#quality-checks-in-the-gate)
    expect(vision.calls[0]!.system).toContain('- duplicates: anyone or anything shown twice');
    const input = JSON.parse((vision.calls[0]!.parts[0] as { text: string }).text.replace(/^[^{]*/, ''));
    expect(input.absent).toEqual([{ name: 'Sammy', look: 'a bigger plush panda in a blue jacket' }]);
    expect(vision.calls[0]!.system).toContain('"absent" lists cast members');

    // Without quality checks the judge is not asked about the cast in frame
    await judge.judge({
      characters: [{ id: 'chr_rosie', name: 'Rosie', identity: 'a small plush panda', references: [] }],
      frames: [Buffer.from('png')],
      shotDescription: 'Rosie points at the chart',
      absent: [{ name: 'Sammy', look: 'a bigger plush panda' }],
    });
    const plain = JSON.parse((vision.calls[1]!.parts[0] as { text: string }).text.replace(/^[^{]*/, ''));
    expect(plain).not.toHaveProperty('absent');
  });

  it('reads verdicts that name a character instead of its id, and drops strays in the lists', async () => {
    const vision = new ScriptedVision({
      frames: [
        {
          index: 0,
          characters: [
            { name: 'Rosie', present: true, identityScore: 0.88, issues: [] },
            'Sammy is not in this shot',
            { name: 'Nobody', present: true, identityScore: 0.9 },
          ],
          elements: [{ name: 'Rental shop', present: true, score: 0.8 }, 'the chart'],
        },
      ],
    });
    const judge = new VisionLlmJudge(new LlmTasks(vision, vision));
    const out = await judge.judge({
      characters: [{ id: 'chr_rosie', name: 'Rosie', identity: 'a small plush panda', references: [] }],
      elements: [
        { id: 'ele_shop', kind: 'location', name: 'Rental Shop', description: 'wood', references: [] },
      ],
      frames: [Buffer.from('png')],
      shotDescription: 'Rosie points at the chart',
    });
    expect(out.characters).toEqual([
      [{ characterId: 'chr_rosie', present: true, identityScore: 0.88, outfitScore: undefined, issues: [] }],
    ]);
    expect(out.elements).toEqual([[{ elementId: 'ele_shop', present: true, score: 0.8, issues: [] }]]);
    // No repair round was needed
    expect(vision.calls).toHaveLength(1);
  });
});
