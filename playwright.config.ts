import { defineConfig } from '@playwright/test';

const port = Number(process.env.RIDEO_E2E_PORT ?? 8797);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }], ['list']] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /responsive\.spec\.ts/,
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      testMatch:
        /(responsive|mcp-sync|provenance|elements|dialogue|storyboard|directing|take-editing|multi-shot|post-audio|localization|finishing|accounts|review|interchange|editor-depth|recipes|brand|search|performance|engine|pwa)\.spec\.ts/,
      use: {
        browserName: 'chromium',
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: 'npx tsx e2e/support/stack.ts',
    url: `${baseURL}/api/ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    env: { RIDEO_E2E_PORT: String(port) },
    // SIGTERM lets the stack remove its data and the mock gateway's files (e2e/support/stack.ts).
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});
