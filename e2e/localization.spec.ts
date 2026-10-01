import { expect, test } from '@playwright/test';
import { Api } from './support/api';
import { exportInThisTab } from './support/ui';

/** Subtitles and localization (docs/design/localization.md) in the editor and the exports, desktop and phone. */
test('captions animate word by word; the cut is translated, dubbed, corrected and exported in Spanish', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(420_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Localization (${testInfo.project.name})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false } },
  });
  await api.readyForStoryboard(pid);
  let state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  await api.waitJob(pid, plan.id);
  state = await api.call<any>('GET', `/projects/${pid}/state`);
  const clip = Object.values<any>(state.docs.clips)[0];
  const speaking = clip.shots.find((s: any) => s.dialogue.some((d: any) => d.characterId));
  await api.call('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${speaking.id}`, {
    camera: { ...speaking.camera, framing: 'close_up' },
  });
  const gen = await api.call<any>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
  await api.waitJob(pid, gen.id, 180_000);
  await api.waitIdle(pid, 180_000);
  await api.call('POST', `/projects/${pid}/clips/${clip.id}/approve`);
  await api.call('POST', `/projects/${pid}/timeline/assemble`, { captions: true });

  await page.goto(`/p/${pid}/editor`);
  const panel = page.getByTestId('localization-panel');
  await expect(panel).toBeVisible();
  // word-by-word captions
  await panel.getByTestId('caption-style').selectOption('build');
  await expect
    .poll(async () => {
      const t = await api.call<any>('GET', `/projects/${pid}/timeline`);
      return t.tracks.find((x: any) => x.kind === 'text').items.find((i: any) => i.style.preset === 'caption')
        ?.style.animate;
    })
    .toBe('build');
  await expect(panel.getByTestId('download-srt').first()).toHaveAttribute('href', /subtitles\.srt/);

  // Spanish: translated, dubbed with the locked voices, the close-up lip-synced
  await panel.getByTestId('add-language-select').selectOption('es');
  await expect(panel.getByTestId('add-language-dub')).toBeChecked();
  await panel.getByTestId('add-language').click();
  const row = panel.locator('[data-language="es"]');
  await expect(row.getByTestId('language-lipsync')).toHaveText('lip-synced 1', { timeout: 240_000 });
  await expect(row.getByTestId('language-dubs')).toHaveText(/dubbed (\d+)\/\1/);
  await expect(row.getByTestId('language-lines')).toHaveText(/lines (\d+)\/\1/);

  // a corrected line makes its dub stale until it is dubbed again
  await row.getByTestId('edit-translations').click();
  const first = page.getByTestId('translations').locator('li').first();
  await first.getByTestId('translation-input').fill('Hola, ¿quién escribe?');
  await first.getByTestId('translation-save').click();
  await expect(first.getByTestId('translation-save')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(row.getByTestId('language-dubs')).not.toHaveText(/dubbed (\d+)\/\1/);
  await row.getByTestId('dub-language').click();
  await expect(row.getByTestId('language-dubs')).toHaveText(/dubbed (\d+)\/\1/, { timeout: 180_000 });
  await api.waitIdle(pid);

  // the Spanish variant: dubbed voices, subtitles as files
  await exportInThisTab(page, {
    quality: 'draft',
    engine: 'ffmpeg',
    language: 'es',
    dubbed: true,
    captions: 'sidecar',
  });
  await page.goto(`/p/${pid}/exports`);
  const card = page.locator('[data-entity^="export:"]').first();
  await expect(card.getByTestId('export-language-badge')).toHaveText('Spanish · dubbed');
  await expect(card.getByTestId('download-export-vtt')).toBeVisible();
  const exp = (await api.call<any[]>('GET', `/projects/${pid}/exports`))[0];
  expect(exp).toMatchObject({ status: 'succeeded', language: 'es', dubbed: true, captions: 'sidecar' });
});
