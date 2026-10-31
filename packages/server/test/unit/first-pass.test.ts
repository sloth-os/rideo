import { rubricLines } from '@rideo/shared';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPTS, SYSTEM_PROMPTS_V2 } from '../../src/ai/tasks';

/** One rubric for the maker and the reviewer (docs/design/first-pass.md#one-rubric-for-the-maker-and-the-reviewer). */
describe('makers aim at what their reviewers score', () => {
  it('writes every reviewer prompt from the rubric', () => {
    expect(SYSTEM_PROMPTS['screenplay.review']).toContain(rubricLines('screenplay'));
    expect(SYSTEM_PROMPTS['storyboard.review']).toContain(rubricLines('storyboard'));
    expect(SYSTEM_PROMPTS['cast.review']).toContain(rubricLines('cast'));
  });

  it("gives the writer the screenplay reviewer's rubric, the bar and what the video model cannot film", () => {
    for (const task of ['screenplay.generate', 'screenplay.extend'] as const) {
      const prompt = SYSTEM_PROMPTS_V2[task]!;
      expect(prompt).toContain('a script editor reviews it');
      expect(prompt).toContain('every dimension scores 8 or more');
      expect(prompt).toContain(rubricLines('screenplay', ['feasibility', 'continuity']).split('\n')[0]);
      expect(prompt).toContain('a rider and the animal ridden count as two');
      // The brief first: a hard moment is made filmable, never dropped
      expect(prompt).toContain('The brief comes first');
      expect(prompt).toContain('happens across a cut, with a visible before and after');
      expect(prompt).toContain('who carries each one, in which hand, or where it rests');
      expect(prompt).toContain('"video" is your input "video"');
    }
    // A written scene is reviewed on all eight; the extension's scenes on the seven that judge scenes
    expect(SYSTEM_PROMPTS_V2['screenplay.generate']).toContain(rubricLines('screenplay'));
    expect(SYSTEM_PROMPTS_V2['screenplay.extend']).not.toContain('- pacing: the beats fit');
  });

  it("gives the shot planner the storyboard reviewer's rubric, without what only a drawing decides", () => {
    const prompt = SYSTEM_PROMPTS_V2['clip.plan']!;
    expect(prompt).toContain(
      rubricLines('storyboard', [
        'composition',
        'continuity',
        'coverage',
        'storytelling',
        'feasibility',
        'pacing',
      ]),
    );
    expect(prompt).not.toContain('- blocking:');
    expect(prompt).not.toContain('- character: the cast looks like');
    expect(prompt).toContain('which way each one faces, and who holds which prop in which hand');
    expect(prompt).toContain('a line of six words needs a shot of four seconds');
  });

  it('asks the planner for one geography and the writer for a last pass over the weaknesses', () => {
    expect(SYSTEM_PROMPTS_V2['clip.plan']).toContain("Fix the scene's geography before the shots");
    expect(SYSTEM_PROMPTS_V2['clip.plan']).toContain('a reverse shot shows what was behind the first camera');
    expect(SYSTEM_PROMPTS_V2['clip.plan']).toContain('The video model moves one thing well at a time');
    expect(SYSTEM_PROMPTS_V2['clip.plan']).toContain('never plays as a row of locked-off pictures');
    expect(SYSTEM_PROMPTS_V2['clip.plan']).toContain(
      'its "description" already shows that pose, clear in a still picture',
    );
    expect(SYSTEM_PROMPTS_V2['screenplay.generate']).toContain('go through your screenplay moment by moment');
    expect(SYSTEM_PROMPTS_V2['screenplay.generate']).toContain('A prop that changes place or state between beats');
  });

  it('checks a reference against its subject and the views before it', () => {
    expect(SYSTEM_PROMPTS['reference.check']).toMatch(/^rideo-task: reference\.check/);
    expect(SYSTEM_PROMPTS['reference.check']).toContain('nothing added');
  });

  it("reads a frame beside the scene's opening frame for the place and the look only", () => {
    const reconcile = SYSTEM_PROMPTS['frame.reconcile']!;
    expect(reconcile).toContain('Compare only the place and the look of things');
    expect(reconcile).toContain("a prop's state or place follow the shot, never the opening frame");
    // A landmark or the wind on the other side than the shot says is a reason to draw the frame again
    expect(reconcile).toContain('a landmark on the other side of the frame than the shot puts it');
    expect(reconcile).toContain('blowing against the wind the shot gives');
    expect(reconcile).toContain('the gesture the shot turns on missing or aimed elsewhere');
  });

  it('leaves version 1 prompts as they were', () => {
    expect(SYSTEM_PROMPTS['screenplay.generate']).not.toContain('reviews it on these dimensions');
    expect(SYSTEM_PROMPTS['clip.plan']).not.toContain('reviews it on these dimensions');
  });
});
