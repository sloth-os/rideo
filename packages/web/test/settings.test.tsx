import { SETTING_FIELDS, type SettingsView } from '@rideo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../src/features/settings/SettingsPage';
import { useAuth } from '../src/lib/auth';
import { useConfigStore } from '../src/lib/config';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view(over: Partial<Record<string, Partial<SettingsView['fields'][string]>>> = {}): SettingsView {
  const fields: SettingsView['fields'] = {};
  for (const f of SETTING_FIELDS)
    fields[f.env] = { value: null, source: 'default', locked: false, set: false, ...over[f.env] };
  return {
    fields,
    storage: 'browser',
    gateway: false,
    updatedAt: null,
    updatedBy: null,
    error: null,
    runningJobs: 0,
  };
}

describe('settings page (docs/design/settings.md)', () => {
  let calls: { url: string; init?: RequestInit }[];
  let current: SettingsView;
  let reply: (url: string, init?: RequestInit) => Response | null;
  beforeEach(() => {
    useAuth.setState({
      me: { mode: 'none', provider: null, user: null, token: null, admin: true },
      loaded: true,
    });
    useConfigStore.setState({ config: null, loading: null });
    current = view({
      RIDEO_STORAGE: { value: 'browser', source: 'settings', set: true },
      RIDEO_TTS_PROVIDER: { value: 'elevenlabs', source: 'env', locked: true, set: true },
      MM_GATEWAY_API_KEY: { source: 'settings', set: true },
    });
    calls = [];
    reply = () => null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const custom = reply(url, init);
        if (custom) return custom;
        if (url === '/api/settings' && (!init?.method || init.method === 'GET'))
          return new Response(JSON.stringify(current));
        if (url === '/api/settings' && init?.method === 'PUT') {
          const values = JSON.parse(String(init.body)).values as Record<string, string | null>;
          current = { ...current, gateway: !!values.MM_GATEWAY_URL };
          return new Response(JSON.stringify({ ...current, applied: true, changed: Object.keys(values) }));
        }
        if (url === '/api/config')
          return new Response(JSON.stringify({ features: { gateway: current.gateway } }));
        if (url.startsWith('/api/notifications'))
          return new Response(JSON.stringify({ notifications: [], unread: 0 }));
        return new Response(url.includes('inbox') ? '{"waiting":0}' : '[]');
      }),
    );
  });

  const page = () =>
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

  it('shows where projects are, whether AI is on, and every group of the settings table', async () => {
    page();
    await screen.findByTestId('settings-page');
    expect((await screen.findByTestId('settings-status-storage-value')).textContent).toBe('This browser');
    expect(screen.getByTestId('settings-status-gateway-value').textContent).toMatch(/Not connected/);
    for (const g of ['storage', 'gateway', 'models', 'ai', 'audio', 'accounts', 'appearance'])
      expect(screen.getByTestId(`settings-group-${g}`)).toBeTruthy();
    // a value from the environment is locked
    const tts = screen.getByTestId('setting-RIDEO_TTS_PROVIDER');
    expect(tts.dataset.locked).toBe('true');
    expect((within(tts).getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    // WebDAV fields only when projects are stored on WebDAV
    expect(screen.queryByTestId('setting-RIDEO_WEBDAV_URL')).toBeNull();
    // a stored secret is never shown
    const key = within(screen.getByTestId('setting-MM_GATEWAY_API_KEY')).getByPlaceholderText(
      /set; type to replace/,
    );
    expect((key as HTMLInputElement).value).toBe('');
  });

  it('saves only what changed and reloads the config', async () => {
    page();
    const url = (await screen.findByTestId('setting-MM_GATEWAY_URL')).querySelector('input')!;
    fireEvent.change(url, { target: { value: 'http://gateway.test:8000' } });
    expect(screen.getByTestId('settings-savebar').textContent).toMatch(/1 unsaved change/);
    // typing the stored value back is no change
    const storage = screen.getByTestId('setting-RIDEO_STORAGE').querySelector('select')!;
    fireEvent.change(storage, { target: { value: 'webdav' } });
    expect(screen.getByTestId('settings-savebar').textContent).toMatch(/2 unsaved changes/);
    fireEvent.change(storage, { target: { value: 'browser' } });
    expect(screen.getByTestId('settings-savebar').textContent).toMatch(/1 unsaved change/);
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(JSON.parse(String(put.init!.body))).toEqual({
      values: { MM_GATEWAY_URL: 'http://gateway.test:8000' },
    });
    await waitFor(() => expect(screen.queryByTestId('settings-savebar')).toBeNull());
    await waitFor(() => expect(useConfigStore.getState().config?.features.gateway).toBe(true));
    expect(screen.getByTestId('settings-status-gateway-value').textContent).toMatch(/Connected/);
  });

  it('shows the server’s validation errors under the setting', async () => {
    reply = (url, init) =>
      url === '/api/settings' && init?.method === 'PUT'
        ? new Response(
            JSON.stringify({
              type: 'urn:rideo:problem:validation_error',
              title: 'Validation Error',
              status: 422,
              detail: 'Some settings are not valid',
              code: 'validation_error',
              errors: [{ path: 'RIDEO_CONSISTENCY_THRESHOLD', message: 'Invalid input: expected number' }],
            }),
            { status: 422 },
          )
        : null;
    page();
    const threshold = (await screen.findByTestId('setting-RIDEO_CONSISTENCY_THRESHOLD')).querySelector(
      'input',
    )!;
    fireEvent.change(threshold, { target: { value: 'high' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(
      (await within(screen.getByTestId('setting-RIDEO_CONSISTENCY_THRESHOLD')).findByTestId('setting-error'))
        .textContent,
    ).toMatch(/expected number/);
    expect(screen.getByTestId('settings-savebar')).toBeTruthy();
  });

  it('asks before interrupting running jobs', async () => {
    current = { ...current, runningJobs: 2 };
    page();
    const name = (await screen.findByTestId('setting-RIDEO_BRAND_NAME')).querySelector('input')!;
    fireEvent.change(name, { target: { value: 'Studio Nine' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(screen.getByRole('dialog').textContent).toMatch(/2 jobs are running/);
    expect(calls.some((c) => c.init?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByTestId('settings-confirm'));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
  });

  it('tells people who are not administrators', async () => {
    useAuth.setState({
      me: {
        mode: 'oidc',
        provider: 'SSO',
        user: { id: 'usr_000000000001', email: 'b@x.test', name: 'B', studioRole: 'member', disabled: false },
        token: null,
        admin: false,
      },
    });
    page();
    expect(await screen.findByTestId('settings-forbidden')).toBeTruthy();
  });
});
