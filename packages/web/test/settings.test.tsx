import { type EndpointStatus, SETTING_ENDPOINT_IDS, SETTING_FIELDS, type SettingsView } from '@rideo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldRow } from '../src/features/settings/fields';
import {
  applyChange,
  checkValue,
  groupFromHash,
  matches,
  sectionStates,
} from '../src/features/settings/model';
import { SettingsPage } from '../src/features/settings/SettingsPage';
import { useAuth } from '../src/lib/auth';
import { useConfigStore } from '../src/lib/config';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OFF: EndpointStatus = {
  on: false,
  provider: null,
  url: null,
  domain: null,
  model: null,
  key: 'none',
  keyFrom: null,
  proxy: 'off',
  detail: null,
};

function view(
  over: Partial<Record<string, Partial<SettingsView['fields'][string]>>> = {},
  endpoints: Partial<SettingsView['endpoints']> = {},
): SettingsView {
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
    endpoints: Object.fromEntries(
      SETTING_ENDPOINT_IDS.map((id) => [id, endpoints[id] ?? OFF]),
    ) as SettingsView['endpoints'],
    proxySync: { status: 'idle', at: null, code: null, detail: null },
  };
}

describe('the settings model (docs/design/settings.md#the-settings-page)', () => {
  it('reads sections from the hash, old links included', () => {
    expect(groupFromHash('#ai')).toBe('ai');
    expect(groupFromHash('#settings-gateway')).toBe('gateway');
    expect(groupFromHash('#nope')).toBeNull();
    expect(groupFromHash('')).toBeNull();
  });

  it('counts only real changes, secrets included', () => {
    const v = view({
      RIDEO_BRAND_NAME: { value: 'Nine', source: 'settings', set: true },
      MM_GATEWAY_API_KEY: { source: 'settings', set: true },
    });
    expect(applyChange(v, {}, 'RIDEO_BRAND_NAME', 'Nine')).toEqual({});
    expect(applyChange(v, {}, 'RIDEO_BRAND_NAME', null)).toEqual({ RIDEO_BRAND_NAME: null });
    // a secret: typing nothing is no change, null removes a stored one, and removing an unset one is nothing
    expect(applyChange(v, { MM_GATEWAY_API_KEY: 'x' }, 'MM_GATEWAY_API_KEY', '')).toEqual({});
    expect(applyChange(v, {}, 'MM_GATEWAY_API_KEY', null)).toEqual({ MM_GATEWAY_API_KEY: null });
    expect(applyChange(v, {}, 'RIDEO_LLM_API_KEY', null)).toEqual({});
  });

  it('finds settings by label, card, variable and help, and checks values as they are typed', () => {
    const field = (env: string) => SETTING_FIELDS.find((f) => f.env === env)!;
    expect(matches(field('RIDEO_LLM_API_KEY'), 'text model key')).toBe(true);
    expect(matches(field('RIDEO_LLM_API_KEY'), 'rideo_llm')).toBe(true);
    expect(matches(field('MM_GATEWAY_ADMIN_KEY'), 'management')).toBe(true);
    expect(matches(field('RIDEO_BRAND_NAME'), 'text model')).toBe(false);
    expect(checkValue(field('RIDEO_CONSISTENCY_THRESHOLD'), 'high')).toBe('a number');
    expect(checkValue(field('RIDEO_CONSISTENCY_THRESHOLD'), '0.8')).toBeNull();
    expect(checkValue(field('MM_GATEWAY_URL'), 'gateway:8000')).toMatch(/http/);
    expect(checkValue(field('RIDEO_LLM_PROXY_DOMAIN'), 'https://k:s@ai.example.com/v1')).toMatch(/base URL/);
    expect(checkValue(field('RIDEO_LLM_PROXY_DOMAIN'), 'ai.example.com')).toBeNull();
  });

  it('says what needs attention per section', () => {
    const v = view({}, { llm: { ...OFF, on: true, proxy: 'missing' } });
    const states = sectionStates(v, { RIDEO_TTS_PROVIDER: 'openai' }, { RIDEO_LANES: 'bad' });
    expect(states.ai).toEqual({ changes: 0, attention: true });
    expect(states.audio).toEqual({ changes: 1, attention: false });
    expect(states.jobs).toEqual({ changes: 0, attention: true });
    expect(states.gateway.attention).toBe(false);
  });
});

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
          current = { ...current, gateway: !!values.MM_GATEWAY_URL || current.gateway };
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

  const page = (path = '/settings') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <SettingsPage />
      </MemoryRouter>,
    );
  const nav = (group: string) => fireEvent.click(screen.getByTestId(`settings-nav-${group}`));

  it('shows where projects are, whether AI is on, and one section at a time from the table', async () => {
    page();
    await screen.findByTestId('settings-page');
    expect((await screen.findByTestId('settings-status-storage-value')).textContent).toBe('This browser');
    expect(screen.getByTestId('settings-status-gateway-value').textContent).toMatch(/Not connected/);
    expect(screen.getByTestId('settings-status-ai-value').textContent).toMatch(/Off until mm-gateway/);
    // the storage section opens first; the others are a click away
    expect(screen.getByTestId('settings-group-storage')).toBeTruthy();
    expect(screen.queryByTestId('settings-group-gateway')).toBeNull();
    expect(screen.getByTestId('settings-nav-storage').getAttribute('aria-current')).toBe('page');
    for (const g of ['gateway', 'models', 'ai', 'audio', 'accounts', 'appearance']) {
      nav(g);
      expect(screen.getByTestId(`settings-group-${g}`)).toBeTruthy();
    }
    // WebDAV fields only when projects are stored on WebDAV
    nav('storage');
    expect(screen.queryByTestId('setting-RIDEO_WEBDAV_URL')).toBeNull();
    // a value from the environment is locked
    nav('audio');
    const tts = screen.getByTestId('setting-RIDEO_TTS_PROVIDER');
    expect(tts.dataset.locked).toBe('true');
    expect((within(tts).getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    // a status tile opens its section
    fireEvent.click(screen.getByTestId('settings-status-gateway'));
    expect(screen.getByTestId('settings-group-gateway')).toBeTruthy();
  });

  it('opens the section a link names, and finds settings across sections', async () => {
    page('/settings#settings-gateway');
    expect(await screen.findByTestId('settings-group-gateway')).toBeTruthy();
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'api key' } });
    const results = screen.getByTestId('settings-results');
    expect(within(results).getByTestId('setting-RIDEO_LLM_API_KEY').textContent).toMatch(
      /Text model · API key/,
    );
    expect(within(results).getByTestId('setting-MM_GATEWAY_API_KEY')).toBeTruthy();
    expect(screen.queryByTestId('settings-group-gateway')).toBeNull();
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'no such thing' } });
    expect(screen.getByText(/No setting matches/)).toBeTruthy();
    nav('models');
    expect((screen.getByTestId('settings-search') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('settings-group-models')).toBeTruthy();
  });

  it('keeps rare settings under Advanced, opening it for one that is locked or changed', async () => {
    current = view({ RIDEO_LANES: { value: 'video=4', source: 'env', locked: true, set: true } });
    page('/settings#gateway');
    await screen.findByTestId('settings-group-gateway');
    expect(screen.queryByTestId('setting-RIDEO_GATEWAY_POLL_MS')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-advanced-gateway-toggle'));
    fireEvent.change(screen.getByTestId('setting-RIDEO_GATEWAY_POLL_MS').querySelector('input')!, {
      target: { value: '500' },
    });
    // changed: it stays open
    fireEvent.click(screen.getByTestId('settings-advanced-gateway-toggle'));
    expect(screen.getByTestId('setting-RIDEO_GATEWAY_POLL_MS')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-gateway-changes').textContent).toBe('1');
    // locked in another section: open there from the start
    nav('jobs');
    expect(screen.getByTestId('setting-RIDEO_LANES').dataset.locked).toBe('true');
  });

  it('never shows a secret: set, replaced or removed', async () => {
    page('/settings#gateway');
    const key = await screen.findByTestId('setting-MM_GATEWAY_API_KEY');
    expect(within(key).getByTestId('setting-secret-set').textContent).toMatch(/Set/);
    expect(key.querySelector('input')).toBeNull();
    fireEvent.click(within(key).getByTestId('setting-secret-replace'));
    const input = key.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'new-key' } });
    fireEvent.click(within(key).getByTestId('setting-secret-toggle'));
    expect((key.querySelector('input') as HTMLInputElement).type).toBe('text');
    expect(screen.getByTestId('settings-savebar').textContent).toMatch(/1 unsaved change/);
    fireEvent.click(within(key).getByText('Cancel'));
    expect(screen.queryByTestId('settings-savebar')).toBeNull();
    fireEvent.click(within(key).getByTestId('setting-secret-remove'));
    expect(within(key).getByTestId('setting-secret-removing')).toBeTruthy();
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === 'PUT')!.init!.body))).toEqual({
      values: { MM_GATEWAY_API_KEY: null },
    });
  });

  it('keeps a replacement open through a refresh of the same settings, and ends it on a save', () => {
    const field = SETTING_FIELDS.find((f) => f.env === 'MM_GATEWAY_API_KEY')!;
    const first = view({ MM_GATEWAY_API_KEY: { set: true, source: 'settings' } });
    const { container, rerender } = render(
      <FieldRow field={field} view={first} draft={{}} onChange={() => undefined} />,
    );
    fireEvent.click(screen.getByTestId('setting-secret-replace'));
    expect(container.querySelector('input')).toBeTruthy();
    // The page polls while keys register: a new view object of the same settings (this test failed on CI that way)
    rerender(<FieldRow field={field} view={{ ...first }} draft={{}} onChange={() => undefined} />);
    expect(container.querySelector('input')).toBeTruthy();
    rerender(
      <FieldRow
        field={field}
        view={{ ...first, updatedAt: '2026-10-28T18:00:00.000Z' }}
        draft={{}}
        onChange={() => undefined}
      />,
    );
    expect(container.querySelector('input')).toBeNull();
  });

  it('saves only what changed and reloads the config', async () => {
    page('/settings#gateway');
    const url = (await screen.findByTestId('setting-MM_GATEWAY_URL')).querySelector('input')!;
    fireEvent.change(url, { target: { value: 'http://gateway.test:8000' } });
    expect(screen.getByTestId('settings-savebar').textContent).toMatch(/1 unsaved change/);
    // typing the stored value back is no change
    nav('storage');
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

  it('checks values while typing, and opens the section of a refused one', async () => {
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
    page('/settings#consistency');
    const threshold = (await screen.findByTestId('setting-RIDEO_CONSISTENCY_THRESHOLD')).querySelector(
      'input',
    )!;
    fireEvent.change(threshold, { target: { value: 'high' } });
    expect(
      within(screen.getByTestId('setting-RIDEO_CONSISTENCY_THRESHOLD')).getByTestId('setting-check')
        .textContent,
    ).toMatch(/a number/);
    nav('storage');
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(
      (
        await within(await screen.findByTestId('setting-RIDEO_CONSISTENCY_THRESHOLD')).findByTestId(
          'setting-error',
        )
      ).textContent,
    ).toMatch(/expected number/);
    expect(screen.getByTestId('settings-group-consistency')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-consistency').dataset.attention).toBe('true');
    expect(screen.getByTestId('settings-savebar').textContent).toMatch(/1 refused/);
  });

  it('shows each endpoint with its status, what it calls, and a test of the saved settings', async () => {
    current = view(
      {
        RIDEO_LLM_PROXY_DOMAIN: { value: 'https://ai.example.com/v1', source: 'settings', set: true },
        RIDEO_LLM_API_KEY: { source: 'settings', set: true },
        RIDEO_LLM_MODEL: { value: 'qwen-max', source: 'settings', set: true },
      },
      {
        llm: {
          on: true,
          provider: 'openai',
          url: 'https://ai.example.com/v1',
          domain: 'ai.example.com',
          model: 'qwen-max',
          key: 'own',
          keyFrom: null,
          proxy: 'registered',
          detail: null,
        },
        vision: {
          on: true,
          provider: 'openai',
          url: 'https://ai.example.com/v1',
          domain: 'ai.example.com',
          model: 'qwen-max',
          key: 'shared',
          keyFrom: 'llm',
          proxy: 'registered',
          detail: null,
        },
        stt: OFF,
      },
    );
    current = { ...current, gateway: true };
    reply = (url, init) =>
      url === '/api/settings/test' && init?.method === 'POST'
        ? new Response(
            JSON.stringify({ ok: true, detail: 'qwen-max answered in 640 ms: “OK”', latencyMs: 640 }),
          )
        : null;
    page('/settings#ai');
    const llm = await screen.findByTestId('settings-endpoint-llm');
    expect(llm.dataset.status).toBe('registered');
    expect(within(llm).getByTestId('settings-endpoint-llm-status').textContent).toMatch(
      /registered in mm-gateway/,
    );
    expect(within(llm).getByTestId('settings-endpoint-llm-calls').textContent).toMatch(
      /https:\/\/ai.example.com\/v1\/chat\/completions through mm-gateway’s proxy ai.example.com/,
    );
    const vision = screen.getByTestId('settings-endpoint-vision');
    expect(within(vision).getByTestId('settings-endpoint-vision-shared').textContent).toMatch(
      /text model’s key/,
    );
    expect(screen.getByTestId('settings-status-ai-value').textContent).toMatch(/2 endpoints ready/);
    // the test uses the saved settings
    fireEvent.click(within(llm).getByTestId('settings-endpoint-llm-test'));
    expect((await within(llm).findByTestId('settings-endpoint-llm-result')).dataset.ok).toBe('true');
    const test = calls.find((c) => c.url === '/api/settings/test')!;
    expect(JSON.parse(String(test.init!.body))).toEqual({ target: 'llm', values: {} });
    // an unsaved change: save first; what it calls follows the draft
    fireEvent.change(within(llm).getByTestId('setting-RIDEO_LLM_PROXY_DOMAIN').querySelector('input')!, {
      target: { value: 'https://ark.example.cn/api/v3' },
    });
    expect(within(llm).getByTestId('settings-endpoint-llm-status').dataset.status).toBe('unsaved');
    expect((within(llm).getByTestId('settings-endpoint-llm-test') as HTMLButtonElement).disabled).toBe(true);
    expect(within(llm).getByTestId('settings-endpoint-llm-calls').textContent).toMatch(
      /https:\/\/ark.example.cn\/api\/v3\/chat\/completions/,
    );
    // an optional endpoint that is off cannot be tested
    expect(
      (
        within(screen.getByTestId('settings-endpoint-stt')).getByTestId(
          'settings-endpoint-stt-test',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('says why a key is not registered', async () => {
    current = {
      ...view(
        { RIDEO_LLM_API_KEY: { source: 'settings', set: true } },
        {
          llm: {
            ...OFF,
            on: true,
            provider: 'openai',
            domain: 'api.openai.com',
            key: 'own',
            proxy: 'failed',
            detail: 'mm-gateway refused the admin token (401)',
          },
        },
      ),
      gateway: true,
      proxySync: {
        status: 'failed',
        at: null,
        code: 'gateway_admin_unauthorized',
        detail: 'mm-gateway refused the admin token (401)',
      },
    };
    page('/settings#ai');
    const llm = await screen.findByTestId('settings-endpoint-llm');
    expect(within(llm).getByTestId('settings-endpoint-llm-detail').textContent).toMatch(
      /refused the admin token/,
    );
    expect(screen.getByTestId('settings-nav-ai').dataset.attention).toBe('true');
    expect(screen.getByTestId('settings-nav-gateway').dataset.attention).toBe('true');
    expect(screen.getByTestId('settings-status-ai').dataset.tone).toBe('warning');
    nav('gateway');
    expect(screen.getByTestId('settings-proxy-sync').dataset.status).toBe('failed');
  });

  it('asks before interrupting running jobs', async () => {
    current = { ...current, runningJobs: 2 };
    page('/settings#provenance');
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
