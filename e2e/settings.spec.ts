import { expect, type Page, test } from '@playwright/test';
import { at, PORTS } from './support/ports';

/** Studio settings in the UI (docs/design/settings.md), on a studio of its own per viewport. */
test.use({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this parameter
  baseURL: async ({}, use, testInfo) =>
    use(at(testInfo.project.name === 'mobile' ? PORTS.settingsMobile : PORTS.settings)),
});

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('administrators connect mm-gateway in Settings, AI features appear at once, and go away again', async ({
  page,
}) => {
  await page.goto('/');
  // Without a gateway the studio is an editor
  await expect(page.getByTestId('ai-off')).toBeVisible();
  await expect(page.getByTestId('new-story')).toBeDisabled();
  await expect(page.getByTestId('new-edit')).toBeEnabled();

  await page.getByTestId('settings-link').click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('settings-status-gateway-value')).toContainText('Not connected');
  await expect(page.getByTestId('settings-status-storage-value')).toHaveText('Built-in WebDAV server');
  // set by the environment of the e2e stack: shown, locked
  const storage = page.getByTestId('setting-RIDEO_STORAGE');
  await expect(storage).toHaveAttribute('data-locked', 'true');
  await expect(storage.getByRole('combobox')).toBeDisabled();
  await noHorizontalScroll(page);

  const url = page.locator('input[name="MM_GATEWAY_URL"]');
  await url.fill(at(PORTS.gateway));
  await expect(page.getByTestId('settings-savebar')).toContainText('1 unsaved change');
  await page.getByTestId('settings-test-gateway').click();
  await expect(page.getByTestId('settings-test-result')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('settings-test-result')).toContainText('model');
  // an invalid value is refused with the reason under the setting
  const threshold = page.locator('input[name="RIDEO_CONSISTENCY_THRESHOLD"]');
  await threshold.fill('high');
  await page.getByTestId('settings-save').click();
  await expect(
    page.getByTestId('setting-RIDEO_CONSISTENCY_THRESHOLD').getByTestId('setting-error'),
  ).toBeVisible();
  await threshold.fill('');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-status-gateway-value')).toContainText('Connected', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('settings-savebar')).toHaveCount(0);
  await expect(page.getByTestId('setting-MM_GATEWAY_URL')).toHaveAttribute('data-source', 'settings');

  // The rest of the studio follows without a reload; the live channel reconnects to the new services
  await page.goBack();
  await expect(page.getByTestId('new-story')).toBeEnabled();
  await expect(page.getByTestId('ai-off')).toHaveCount(0);
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live', { timeout: 30_000 });

  // A new film's screenplay is written by the gateway now
  await page.getByTestId('new-story').click();
  await page.getByLabel('Title').fill('Settings e2e');
  await page.locator('textarea[name="prompt"]').fill('A lighthouse keeper receives letters from the future');
  await page.getByTestId('create-project-submit').click();
  await expect(page).toHaveURL(/\/story$/);

  // Back to no gateway: the default comes back, AI goes away
  await page.goto('/settings');
  await page.getByTestId('setting-MM_GATEWAY_URL').getByTestId('setting-reset').click();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-status-gateway-value')).toContainText('Not connected', {
    timeout: 30_000,
  });
  await page.goto('/');
  await expect(page.getByTestId('ai-off')).toBeVisible();
});
