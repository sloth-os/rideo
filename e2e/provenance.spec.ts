import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Api, makeFootage } from './support/api';

// 1×1 PNG: a stand-in for an uploaded photo of an actor.
const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('an uploaded likeness of a real person needs a consent record', async ({ page, request }, testInfo) => {
  const api = new Api(request);
  const pid = await api.storyProject(`Consent (${testInfo.project.name})`, { screenplay: true });
  await page.goto(`/p/${pid}/cast`);
  const card = page.locator('[data-entity^="character:"]').first();
  await expect(card.getByTestId('character-name')).toBeVisible();
  await card.getByTestId('upload-reference').setInputFiles({
    name: 'actor.png',
    mimeType: 'image/png',
    buffer: PHOTO,
  });
  const dialog = page.getByTestId('consent-dialog');
  await expect(dialog).toContainText('actor.png');
  await page.getByTestId('consent-real').check();
  // A real person needs who is shown, who consented and when
  await expect(page.getByTestId('consent-submit')).toBeDisabled();
  await page.getByTestId('consent-subject').fill('Ada Lovelace');
  await page.getByTestId('consent-granted-by').fill('Ada Lovelace');
  await expect(page.getByTestId('consent-submit')).toBeEnabled();
  await page.getByTestId('consent-submit').click();
  await expect(dialog).toBeHidden();
  await expect(card.getByTestId('reference')).toHaveCount(1);
  await expect(card.getByText('real person')).toBeVisible();
  await expect(card.getByLabel('Real person with consent')).toBeVisible();
  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const consent = Object.values<any>(state.docs.characters)
    .flatMap((c) => c.references)
    .find((r) => r.consent)?.consent;
  expect(consent).toMatchObject({
    depictsRealPerson: true,
    subject: 'Ada Lovelace',
    recordedBy: { kind: 'user' },
  });
});

test('exports carry Content Credentials and the disclosure label; the Verify page reads them', async ({
  page,
  request,
}, testInfo) => {
  const api = new Api(request);
  const pid = await api.editProjectWithClip(
    `Provenance (${testInfo.project.name})`,
    makeFootage(testInfo.outputPath('clip.mp4')),
  );
  // The disclosure label is a project setting
  await page.goto(`/p/${pid}/overview`);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('disclosure-label').selectOption('always');
  await page.getByTestId('disclosure-text').fill('Synthetic media');
  await page.getByTestId('settings-save').click();
  await expect
    .poll(async () => (await api.call<any>('GET', `/projects/${pid}/state`)).docs.project.settings.disclosure)
    .toEqual({ label: 'always', text: 'Synthetic media', position: 'top_right' });

  // This open tab renders the export (editor job); the server watermarks and signs it.
  await page.goto(`/p/${pid}/exports`);
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live');
  const { export: created } = await api.call<any>('POST', `/projects/${pid}/exports`, { quality: 'draft' });
  expect(created.disclosure).toMatchObject({ label: true, text: 'Synthetic media', reason: 'policy' });
  const card = page.locator(`[data-entity="export:${created.id}"]`);
  await expect(card.getByTestId('download-export')).toBeVisible({ timeout: 180_000 });
  await expect(card).toContainText('Content Credentials');
  await expect(card).toContainText('label “Synthetic media”');
  await card.getByTestId('verify-export').click();
  const panel = card.getByTestId('content-credentials');
  await expect(panel).toHaveAttribute('data-state', 'valid');
  await expect(panel).toContainText('bound to the watermark');
  await expect(panel).toContainText('“Synthetic media”');

  // The public Verify page: drop the downloaded file
  const [exp] = await api.call<any[]>('GET', `/projects/${pid}/exports`);
  const bytes = await (await request.get(`/api/projects/${pid}/media/${exp.media.path}`)).body();
  const file = testInfo.outputPath('export.mp4');
  writeFileSync(file, bytes);
  await page.goto('/verify');
  await page.getByTestId('verify-input').setInputFiles(file);
  const result = page.getByTestId('verify-page-result');
  await expect(result).toContainText(`Watermark found: ${exp.watermarkId}`, { timeout: 60_000 });
  await expect(result.getByTestId('content-credentials')).toContainText('Content Credentials');
  await expect(result.getByTestId('content-credentials')).toContainText('placed');
});
