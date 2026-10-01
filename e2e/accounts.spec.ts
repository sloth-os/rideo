import { expect, type Page, test } from '@playwright/test';

/** Accounts, roles and teams (docs/design/accounts.md) on the e2e stack's second server, desktop and phone. */
const ACCOUNTS = `http://127.0.0.1:${Number(process.env.RIDEO_E2E_PORT ?? 8797) + 1}`;

const menu = async (page: Page, item: string) => {
  await page.getByTestId('user-menu').click();
  await page.getByTestId(item).click();
};

test('people sign in, share a project with roles, create agent tokens and read the audit log', async ({
  page,
  browser,
}, testInfo) => {
  const reviewer = testInfo.project.name === 'mobile' ? 'ben@studio.test' : 'cleo@studio.test';
  // Nobody signed in: the sign-in page, then the provider signs in its first person (Mira, an administrator)
  await page.goto(`${ACCOUNTS}/`);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await expect(page.getByTestId('sign-in')).toContainText('Studio SSO');
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('user-menu')).toBeVisible();

  const created = await page.request.post(`${ACCOUNTS}/api/projects`, {
    data: { kind: 'story', title: `Shared film (${testInfo.project.name})` },
  });
  const project = await created.json();
  await page.goto(`${ACCOUNTS}/p/${project.id}/overview`);
  const members = page.getByTestId('members-card');
  await expect(members.getByTestId('my-role')).toHaveText('you: director');
  await members.getByTestId('add-member-email').fill(reviewer);
  await members.getByTestId('add-member-role').selectOption('reviewer');
  await members.getByTestId('add-member').click();
  await members.getByTestId('members-save').click();
  await expect(members.locator(`[data-email="${reviewer}"]`)).toBeVisible();
  // the director and the reviewer (a member, or invited when they never signed in)
  await expect
    .poll(async () => {
      const access = await (await page.request.get(`${ACCOUNTS}/api/projects/${project.id}/access`)).json();
      return access.members.length + access.invites.length;
    })
    .toBe(2);

  // An agent token: shown once, reads with its role, then revoked
  await menu(page, 'user-menu-tokens');
  const name = `Claude Code (${testInfo.project.name})`;
  await page.getByTestId('token-name').fill(name);
  await page.getByTestId('token-role').selectOption('reviewer');
  await page.getByTestId('token-create').click();
  const secret = (await page.getByTestId('token-secret-value').textContent())!;
  expect(secret).toMatch(/^rdo_/);
  const asAgent = await page.request.get(`${ACCOUNTS}/api/projects`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect((await asAgent.json()).find((p: { id: string }) => p.id === project.id).role).toBe('reviewer');
  await page.getByTestId('token-row').filter({ hasText: name }).getByTestId('token-revoke').click();
  await expect(page.getByTestId('token-row').filter({ hasText: name })).toContainText('revoked');

  // People and the audit log
  await menu(page, 'user-menu-admin');
  await expect(page.getByTestId('people-row').filter({ hasText: 'Mira Keeper' })).toBeVisible();
  await page.getByTestId('audit-type').selectOption('project.access');
  await expect(page.getByTestId('audit-row').first()).toHaveAttribute('data-type', 'project.access');

  // The reviewer signs in elsewhere: reading, no approving or settings
  const other = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
  const rp = await other.newPage();
  await rp.goto(
    `${ACCOUNTS}/api/auth/login?login_hint=${encodeURIComponent(reviewer)}&returnTo=${encodeURIComponent(`/p/${project.id}/overview`)}`,
  );
  await expect(rp.getByTestId('role-banner')).toBeVisible();
  await expect(rp.getByTestId('open-settings')).toBeDisabled();
  await expect(rp.getByTestId('members-card').getByTestId('my-role')).toHaveText('you: reviewer');
  await other.close();

  await menu(page, 'sign-out');
  await expect(page).toHaveURL(/\/login/);
});
