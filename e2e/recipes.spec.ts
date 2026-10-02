import { expect, test } from '@playwright/test';
import { Api, makeFootage } from './support/api';

/** Recipes (docs/design/agents.md#recipes): a studio recipe run from the overview with its parameters. */
test('a studio recipe runs on the project from the overview, and is deleted', async ({
  page,
  request,
}, testInfo) => {
  const api = new Api(request);
  const pid = await api.editProjectWithClip(
    `Recipes (${testInfo.project.name})`,
    makeFootage(testInfo.outputPath('clip.mp4')),
  );
  const name = `Titles from a list (${testInfo.project.name})`;
  const recipe = await api.call<any>('POST', '/recipes', {
    name,
    description: 'A title per text',
    params: [{ name: 'texts', type: 'ids', required: true }],
    steps: [
      {
        tool: 'timeline_apply',
        forEach: '{{texts}}',
        args: {
          projectId: '{{projectId}}',
          ops: [
            {
              op: 'add_text',
              item: { kind: 'text', start: 0, duration: 2, text: '{{item}}', style: { preset: 'title' } },
            },
          ],
        },
      },
    ],
  });

  await page.goto(`/p/${pid}/overview`);
  const card = page.getByTestId('recipes-card');
  await expect(card.getByTestId('recipe-row').filter({ hasText: 'Cast every voice' })).toBeVisible();
  const row = card.getByTestId('recipe-row').filter({ hasText: name });
  await expect(row).toContainText('timeline_apply');
  await row.getByTestId('recipe-run').click();
  await page.getByTestId('recipe-param-texts').fill('Opening, Closing');
  await page.getByTestId('recipe-start').click();
  await expect
    .poll(async () => {
      const t = await api.call<any>('GET', `/projects/${pid}/timeline`);
      return t.tracks
        .filter((x: any) => x.kind === 'text')
        .flatMap((x: any) => x.items.map((i: any) => i.text));
    })
    .toEqual(['Opening', 'Closing']);

  await row.getByTestId('recipe-delete').click();
  await expect(row).toHaveCount(0);
  expect((await api.call<any[]>('GET', '/recipes')).some((r) => r.id === recipe.id)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
