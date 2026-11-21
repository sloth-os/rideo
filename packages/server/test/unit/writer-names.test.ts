import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPTS, SYSTEM_PROMPTS_V2 } from '../../src/ai/tasks';

/**
 * The writer is told to keep the project's names (docs/design/continuity.md#storytelling): every prompt version of
 * `screenplay.generate` and `screenplay.extend` reads `existing` and asks for its exact names.
 */
describe("the writer's prompts keep the project's names", () => {
  const prompts: Record<string, string> = {
    'generate v1': SYSTEM_PROMPTS['screenplay.generate'],
    'extend v1': SYSTEM_PROMPTS['screenplay.extend'],
    'generate v2': SYSTEM_PROMPTS_V2['screenplay.generate']!,
    'extend v2': SYSTEM_PROMPTS_V2['screenplay.extend']!,
  };

  it.each(Object.entries(prompts))('%s reads "existing" and keeps its exact names', (_, prompt) => {
    expect(prompt).toContain('When "existing" is given');
    expect(prompt).toContain('"existing.characters"');
    expect(prompt).toContain('"existing.elements"');
    expect(prompt).toMatch(/use its exact "name" everywhere you name it, never a nickname/);
    expect(prompt).toContain('give new names only to people, places and objects that are not among them');
  });

  it('says it once per prompt, before the answer format', () => {
    for (const prompt of Object.values(prompts)) {
      expect(prompt.split('When "existing" is given')).toHaveLength(2);
      expect(prompt.indexOf('When "existing" is given')).toBeLessThan(prompt.indexOf('Return only JSON'));
    }
  });
});
