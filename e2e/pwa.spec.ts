import { createECDH, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Api } from './support/api';
import { connectAgent } from './support/mcp';

/** The installable app (docs/design/pwa.md): shell and service worker, the Inbox, notifications on this device. */
test('the app installs, starts offline, and its Inbox approves gates and follows agents and jobs', async ({
  page,
  request,
  context,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const title = `Inbox (${testInfo.project.name})`;
  const pid = await api.storyProject(title, { screenplay: true });
  // An agent changes the project; a recipe fails
  const agent = await connectAgent(baseURL!);
  try {
    await agent.call('project_update', { projectId: pid, title: `${title} · agent` });
  } finally {
    await agent.client.close();
  }
  const failed = await api.call<{ id: string }>(
    'POST',
    `/projects/${pid}/recipes/${encodeURIComponent('builtin:clip_variations')}/run`,
    { params: { clipId: 'clp_000000missing' } },
  );
  await expect
    .poll(
      async () => (await api.call<{ status: string }>('GET', `/projects/${pid}/jobs/${failed.id}`)).status,
    )
    .toBe('failed');

  // Installable: the manifest, and the service worker controlling the app
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ name: 'Rideo Studio', short_name: 'Rideo', display: 'standalone' });
  await page.goto('/');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)).toMatch(
    /\/sw\.js$/,
  );

  // The Inbox, from the header (phones too)
  await expect(page.getByTestId('inbox-count')).toBeVisible();
  await page.getByTestId('inbox-link').click();
  await expect(page).toHaveURL(/\/inbox$/);
  const approval = page.getByTestId('inbox-approval').filter({ hasText: `${title} · agent` });
  await expect(approval).toContainText('Approve screenplay');
  await expect(
    page
      .getByTestId('inbox-agent')
      .filter({ hasText: `${title} · agent` })
      .first(),
  ).toContainText('Claude Code');
  await expect(
    page
      .getByTestId('inbox-job')
      .filter({ hasText: `${title} · agent` })
      .filter({ hasText: 'failed' })
      .first(),
  ).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await approval.getByTestId('inbox-approve').click();
  await expect(approval).toBeHidden();
  expect((await api.call<{ stage: string }>('GET', `/projects/${pid}/workflow`)).stage).not.toBe(
    'screenplay',
  );

  // Notifications on this device: headless browsers have no push service nor notification prompt, so the permission
  // and the subscription are stand-ins (with real keys); the server keeps the device, and forgets it when turned off
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
  const endpoint = `https://push.example.test/send/${testInfo.project.name}`;
  await page.addInitScript(
    ({ keys, endpoint }) => {
      let permission: NotificationPermission = 'default';
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission });
      Notification.requestPermission = async () => {
        permission = 'granted';
        return permission;
      };
      let current: unknown = null;
      const fake = {
        endpoint,
        toJSON: () => ({ endpoint, keys }),
        unsubscribe: async () => {
          current = null;
          return true;
        },
      };
      PushManager.prototype.getSubscription = async () => current as PushSubscription | null;
      PushManager.prototype.subscribe = async () => {
        current = fake;
        return fake as unknown as PushSubscription;
      };
    },
    { keys, endpoint },
  );
  await page.reload();
  const toggle = page.getByTestId('push-toggle');
  await expect(toggle).toHaveAttribute('data-state', 'off');
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-state', 'on');
  expect((await api.call<{ endpoints: string[] }>('GET', '/push/subscriptions')).endpoints).toContain(
    endpoint,
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-state', 'off');
  expect((await api.call<{ endpoints: string[] }>('GET', '/push/subscriptions')).endpoints).not.toContain(
    endpoint,
  );

  // Offline, the app still starts from its shell and says so
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('offline')).toBeVisible();
  await context.setOffline(false);
});
