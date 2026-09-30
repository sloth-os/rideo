import { expect, test } from '@playwright/test';
import { Api } from './support/api';
import { connectAgent } from './support/mcp';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('an agent drives the studio over MCP and the open page follows live', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const api = new Api(request);
  const pid = await api.storyProject(`MCP sync (${testInfo.project.name})`);
  const agent = await connectAgent(baseURL!);
  try {
    await page.goto(`/p/${pid}/overview`);
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live');
    await expect
      .poll(async () => (await agent.call<any[]>('ui_sessions', { projectId: pid })).length)
      .toBeGreaterThan(0);
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });

    // The agent moves the user's view
    const nav = await agent.call('ui_navigate', { projectId: pid, view: 'cast' });
    expect(nav.acked.length).toBeGreaterThan(0);
    await expect(page).toHaveURL(new RegExp(`/p/${pid}/cast$`));

    // Domain changes by the agent appear without a reload
    const nova = await agent.call('character_create', {
      projectId: pid,
      name: 'Nova',
      role: 'supporting',
      identity: { hair: 'silver bob', eyes: 'grey eyes' },
    });
    const card = page.locator(`[data-entity="character:${nova.id}"]`);
    await expect(card.getByTestId('character-name')).toHaveText('Nova');
    await agent.call('character_add_reference', {
      projectId: pid,
      characterId: nova.id,
      uri: PNG,
      view: 'front',
    });
    await expect(card.getByTestId('reference')).toHaveCount(1);
    await agent.call('character_lock', { projectId: pid, characterId: nova.id });
    await expect(card.getByTestId('unlock-character')).toBeVisible();

    // Focus and notifications
    await agent.call('ui_focus', { projectId: pid, kind: 'character', id: nova.id });
    await expect(card).toHaveAttribute('data-highlighted', 'true');
    await agent.call('ui_notify', { projectId: pid, message: 'Nova is locked and ready', level: 'success' });
    const toast = page.getByTestId('toast').filter({ hasText: 'Nova is locked and ready' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Claude Code');

    if (testInfo.project.name === 'desktop') {
      await expect(page.getByTestId('activity-feed')).toContainText('Claude Code');
    }
    // History attributes the agent's commits
    await agent.call('ui_navigate', { projectId: pid, view: 'history' });
    await expect(page).toHaveURL(new RegExp(`/p/${pid}/history$`));
    await expect(page.getByTestId('commit').filter({ hasText: 'Lock character Nova' }).first()).toContainText(
      'Claude Code',
    );
    // …and none of this needed a page reload
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  } finally {
    await agent.client.close();
  }
});
