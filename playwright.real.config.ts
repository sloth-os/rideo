import { defineConfig } from '@playwright/test';
import { REAL_PORTS } from './e2e/real/ports';

const baseURL = `http://127.0.0.1:${REAL_PORTS.studio}`;

/** The real-model suite (docs/testing.md#real-models-e2ereal): real mm-gateway, real providers, real costs. */
export default defineConfig({
  testDir: 'e2e/real',
  testMatch: /\.spec\.ts$/,
  outputDir: 'test-results/real',
  // Video models take minutes per shot.
  timeout: 45 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  // A failure is reported, not paid for twice.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-real' }], ['list']]
    : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npx tsx e2e/real/stack.ts',
    url: `${baseURL}/api/ready`,
    reuseExistingServer: !process.env.CI,
    // Pulling the gateway image comes first.
    timeout: 300_000,
    stdout: 'pipe',
    env: { RIDEO_REAL_PORT: String(REAL_PORTS.studio) },
    // SIGTERM lets the stack save the gateway's log and remove its container and data (e2e/real/stack.ts).
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
  },
});
