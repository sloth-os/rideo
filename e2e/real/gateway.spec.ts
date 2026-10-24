import { expect, test } from '@playwright/test';
import { readRealEnv, VISION_APIS } from './env';

const env = readRealEnv(process.env);

test('the studio reaches the real mm-gateway through the SDK and lists the pinned models', async ({
  page,
  request,
}) => {
  // Readiness asks the gateway's /health (MetaApi.getHealth)
  const ready = await (await request.get('/api/ready')).json();
  expect(ready.checks.gateway).toEqual({ ok: true });
  expect(ready.checks.llm.detail).toBe(
    `${VISION_APIS[env.VISION_MODEL_TYPE].provider}:${env.VISION_MODEL} via /proxy/${new URL(env.VISION_MODEL_BASE_URL).hostname}`,
  );

  // The model limits come from the gateway's catalog (MetaApi.listModelLimits), the suite's lengths included
  const config = await (await request.get('/api/config')).json();
  expect(config.features.ai).toBe(true);
  expect(config.llm).toEqual({
    provider: VISION_APIS[env.VISION_MODEL_TYPE].provider,
    model: env.VISION_MODEL,
    vision: env.VISION_MODEL,
  });
  expect(config.models.image.map((m: { id: string }) => m.id)).toContain(env.IMAGE_MODEL);
  const video = config.models.video.find((m: { id: string }) => m.id === env.VIDEO_GEN_MODEL);
  expect(video?.limits).toMatchObject({
    min_duration_seconds: env.VIDEO_GEN_DURATION_SEC,
    max_duration_seconds: env.VIDEO_GEN_DURATION_SEC,
  });
  expect(config.defaults.models).toMatchObject({ image: env.IMAGE_MODEL, video: env.VIDEO_GEN_MODEL });

  // Settings tests the same connection from the page
  await page.goto('/settings#gateway');
  await expect(page.getByTestId('settings-status-gateway-value')).toContainText('Connected');
  await page.getByTestId('settings-test-gateway').click();
  const result = page.getByTestId('settings-test-result');
  await expect(result).toHaveAttribute('data-ok', 'true');
  await expect(result).toContainText(/Connected: \d+ model/);

  // and the text model with one real word through the gateway's proxy (docs/design/settings.md#endpoint-status-and-tests)
  await page.getByTestId('settings-nav-ai').click();
  const llm = page.getByTestId('settings-endpoint-llm');
  await expect(llm.getByTestId('settings-endpoint-llm-calls')).toContainText(
    new URL(env.VISION_MODEL_BASE_URL).hostname,
  );
  await llm.getByTestId('settings-endpoint-llm-test').click();
  const answer = llm.getByTestId('settings-endpoint-llm-result');
  await expect(answer).toHaveAttribute('data-ok', 'true', { timeout: 120_000 });
  await expect(answer).toContainText(env.VISION_MODEL);
});
