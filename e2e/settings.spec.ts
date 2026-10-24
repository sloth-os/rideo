import { expect, type Page, test } from '@playwright/test';
import { at, GATEWAY_ADMIN_KEY, PORTS } from './support/ports';

/** Studio settings in the UI (docs/design/settings.md), on a studio of its own per viewport. */
test.use({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this parameter
  baseURL: async ({}, use, testInfo) =>
    use(at(testInfo.project.name === 'mobile' ? PORTS.settingsMobile : PORTS.settings)),
});

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

const section = (page: Page, group: string) => page.getByTestId(`settings-nav-${group}`).click();

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
  await expect(page.getByTestId('settings-status-ai-value')).toContainText('Off until mm-gateway');
  // set by the environment of the e2e stack: shown, locked
  const storage = page.getByTestId('setting-RIDEO_STORAGE');
  await expect(storage).toHaveAttribute('data-locked', 'true');
  await expect(storage.getByRole('combobox')).toBeDisabled();
  await noHorizontalScroll(page);

  // a setting found by searching, from any section
  await page.getByTestId('settings-search').fill('gateway url');
  await expect(page.getByTestId('settings-results').getByTestId('setting-MM_GATEWAY_URL')).toBeVisible();
  await section(page, 'gateway');
  await expect(page).toHaveURL(/\/settings#gateway$/);
  await expect(page.getByTestId('settings-search')).toHaveValue('');

  const url = page.locator('input[name="MM_GATEWAY_URL"]');
  await url.fill(at(PORTS.gateway));
  await expect(page.getByTestId('settings-savebar')).toContainText('1 unsaved change');
  await expect(page.getByTestId('settings-nav-gateway-changes')).toHaveText('1');
  await page.getByTestId('settings-test-gateway').click();
  await expect(page.getByTestId('settings-test-result')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('settings-test-result')).toContainText('model');
  // an invalid value is flagged as it is typed, refused under its field, and its section opened
  await section(page, 'consistency');
  const threshold = page.locator('input[name="RIDEO_CONSISTENCY_THRESHOLD"]');
  await threshold.fill('high');
  await expect(
    page.getByTestId('setting-RIDEO_CONSISTENCY_THRESHOLD').getByTestId('setting-check'),
  ).toBeVisible();
  await section(page, 'storage');
  await page.getByTestId('settings-save').click();
  await expect(
    page.getByTestId('setting-RIDEO_CONSISTENCY_THRESHOLD').getByTestId('setting-error'),
  ).toBeVisible();
  await expect(page.getByTestId('settings-nav-consistency')).toHaveAttribute('data-attention', 'true');
  await threshold.fill('');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-status-gateway-value')).toContainText('Connected', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('settings-savebar')).toHaveCount(0);
  await section(page, 'gateway');
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
  await page.goto('/settings#gateway');
  await page.getByTestId('setting-MM_GATEWAY_URL').getByTestId('setting-reset').click();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-status-gateway-value')).toContainText('Not connected', {
    timeout: 30_000,
  });
  await page.goto('/');
  await expect(page.getByTestId('ai-off')).toBeVisible();
});

test('the text model’s API base URL and key are set in Settings and registered in mm-gateway', async ({
  page,
}, testInfo) => {
  // one domain per viewport: both studios use the same mock gateway at once
  const domain = `ai-${testInfo.project.name}.example.com`;
  await page.goto('/settings#gateway');
  await page.locator('input[name="MM_GATEWAY_URL"]').fill(at(PORTS.gateway));
  await page.locator('input[name="MM_GATEWAY_ADMIN_KEY"]').fill(GATEWAY_ADMIN_KEY);
  await section(page, 'ai');
  const llm = page.getByTestId('settings-endpoint-llm');
  await llm.locator('input[name="RIDEO_LLM_PROXY_DOMAIN"]').fill(`https://${domain}/v1`);
  await llm.locator('input[name="RIDEO_LLM_MODEL"]').fill('mock-llm');
  await llm.locator('input[name="RIDEO_LLM_API_KEY"]').fill('sk-e2e-first');
  // what it will call follows the typing; the test waits for a save
  await expect(llm.getByTestId('settings-endpoint-llm-calls')).toContainText(
    `https://${domain}/v1/chat/completions`,
  );
  await expect(llm.getByTestId('settings-endpoint-llm-status')).toHaveAttribute('data-status', 'unsaved');
  await expect(llm.getByTestId('settings-endpoint-llm-test')).toBeDisabled();
  await expect(page.getByTestId('settings-nav-ai-changes')).toHaveText('3');
  await expect(page.getByTestId('settings-savebar')).toContainText('5 unsaved changes');
  await noHorizontalScroll(page);

  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-savebar')).toHaveCount(0, { timeout: 30_000 });
  await expect(llm).toHaveAttribute('data-status', 'registered');
  await expect(llm.getByTestId('settings-endpoint-llm-status')).toContainText('registered in mm-gateway');
  // the key is never shown again; the vision model shares it (same API)
  await expect(llm.getByTestId('setting-RIDEO_LLM_API_KEY').getByTestId('setting-secret-set')).toContainText(
    'Set',
  );
  const vision = page.getByTestId('settings-endpoint-vision');
  await expect(vision).toHaveAttribute('data-status', 'registered');
  await expect(vision.getByTestId('settings-endpoint-vision-shared')).toContainText('text model’s key');
  await expect(page.getByTestId('settings-status-ai')).toHaveAttribute('data-tone', 'success');
  // a real call through the registered proxy
  await llm.getByTestId('settings-endpoint-llm-test').click();
  await expect(llm.getByTestId('settings-endpoint-llm-result')).toHaveAttribute('data-ok', 'true');
  await expect(llm.getByTestId('settings-endpoint-llm-result')).toContainText('OK');

  // a new key replaces the old one in the gateway
  await llm.getByTestId('setting-RIDEO_LLM_API_KEY').getByTestId('setting-secret-replace').click();
  await llm.locator('input[name="RIDEO_LLM_API_KEY"]').fill('sk-e2e-second');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-savebar')).toHaveCount(0, { timeout: 30_000 });
  await expect(llm).toHaveAttribute('data-status', 'registered');
  await section(page, 'gateway');
  await expect(page.getByTestId('settings-proxy-sync')).toHaveAttribute('data-status', 'ok');

  // removed: the gateway's proxy goes away, and the card says the API is not reachable without one
  await section(page, 'ai');
  await llm.getByTestId('setting-RIDEO_LLM_API_KEY').getByTestId('setting-secret-remove').click();
  await expect(
    llm.getByTestId('setting-RIDEO_LLM_API_KEY').getByTestId('setting-secret-removing'),
  ).toBeVisible();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-savebar')).toHaveCount(0, { timeout: 30_000 });
  await expect(llm).toHaveAttribute('data-status', 'missing');
  await expect(llm.getByTestId('settings-endpoint-llm-detail')).toContainText(`no proxy for ${domain}`);
  await expect(page.getByTestId('settings-nav-ai')).toHaveAttribute('data-attention', 'true');
  await noHorizontalScroll(page);

  // leave the studio as it was
  const reset = await page.request.put('/api/settings', {
    data: {
      values: {
        MM_GATEWAY_URL: null,
        MM_GATEWAY_ADMIN_KEY: null,
        RIDEO_LLM_PROXY_DOMAIN: null,
        RIDEO_LLM_MODEL: null,
      },
    },
  });
  expect(reset.ok()).toBe(true);
});
