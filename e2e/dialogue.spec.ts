import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { Api } from './support/api';

/** A 2 s tone at 180 Hz stands in for a recording of a voice. */
const RECORDING = execFileSync(process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=180:duration=2:sample_rate=16000',
  '-f',
  'wav',
  '-',
]);

test('voices are designed, auditioned, picked and locked; a recording is cloned with consent', async ({
  page,
  request,
}, testInfo) => {
  const api = new Api(request);
  const pid = await api.storyProject(`Voices (${testInfo.project.name})`, { screenplay: true });
  await api.call('POST', `/projects/${pid}/workflow/approve`, { gate: 'screenplay_approved' });
  await page.goto(`/p/${pid}/cast`);
  const [first, second] = [page.getByTestId('voice-panel').nth(0), page.getByTestId('voice-panel').nth(1)];
  await expect(first).toBeVisible();
  // Speaking characters without a voice keep the cast gate closed.
  await expect(page.getByTestId('cast-unmet')).toContainText('without a locked voice');
  await expect(first.getByTestId('lock-voice')).toBeDisabled();

  await first.getByTestId('design-voice').click();
  await expect(first.getByTestId('voice-candidate')).toHaveCount(3, { timeout: 60_000 });
  await expect(first.getByTestId('voice-sample')).toHaveCount(3);
  const src = await first.getByTestId('voice-sample').first().getAttribute('src');
  const audio = await request.get(src!);
  expect(audio.ok()).toBe(true);
  expect(audio.headers()['content-type']).toContain('audio/mpeg');
  await first.getByTestId('select-voice').nth(1).click();
  await expect(first.getByTestId('voice-candidate').nth(1)).toContainText('chosen');
  await first.getByTestId('lock-voice').click();
  await expect(first.getByTestId('voice-locked')).toContainText('voice v1');
  await expect(first.getByTestId('design-voice')).toHaveCount(0);

  // Clone the second character's voice from a recording of a real person, with their consent.
  await second.getByTestId('upload-voice').setInputFiles({
    name: 'tom.wav',
    mimeType: 'audio/wav',
    buffer: RECORDING,
  });
  const dialog = page.getByTestId('consent-dialog');
  await expect(dialog).toContainText('tom.wav');
  await page.getByTestId('consent-real').check();
  await expect(page.getByTestId('consent-submit')).toBeDisabled();
  await page.getByTestId('consent-subject').fill('Tom Reyes');
  await page.getByTestId('consent-granted-by').fill('Tom Reyes');
  await page.getByTestId('consent-submit').click();
  await expect(dialog).toBeHidden();
  await expect(second).toContainText('cloned');
  await expect(second).toContainText('real person');
  await second.getByTestId('lock-voice').click();
  await expect(second.getByTestId('voice-locked')).toContainText('voice v1');
  await expect(page.getByTestId('cast-unmet')).not.toContainText('voice');

  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const voices = Object.values<any>(state.docs.characters).map((c) => c.voice);
  expect(voices.map((v) => v.source).sort()).toEqual(['cloned', 'designed']);
  expect(voices.find((v) => v.source === 'cloned').consent).toMatchObject({
    depictsRealPerson: true,
    subject: 'Tom Reyes',
  });

  // Dialogue mode is a project setting.
  await page.goto(`/p/${pid}`);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('dialogue-mode').selectOption('native');
  await page.getByTestId('settings-save').click();
  await expect(page.getByText('dialogue: native')).toBeVisible();
});
