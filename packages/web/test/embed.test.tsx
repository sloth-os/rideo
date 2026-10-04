import type { Theme } from '@rideo/shared';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineTheme, mountRideo, THEME_TOKENS } from '../src/embed';
import type { RideoTheme } from '../src/embed/types';
import { useConfigStore } from '../src/lib/config';
import { getRuntime, resetRuntime } from '../src/lib/runtime';
import { useUi } from '../src/store/ui';

// The public theme type and the shared schema's stay the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const sameShape: Same<RideoTheme, Theme> = true;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetRuntime();
  document.body.innerHTML = '';
});

describe('the studio as a library (docs/design/embedding.md)', () => {
  let calls: string[];
  beforeEach(() => {
    expect(sameShape).toBe(true);
    useConfigStore.setState({ config: null, loading: null });
    useUi.setState({ themeChosen: false, theme: 'dark' });
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/api/config'))
          return new Response(
            JSON.stringify({
              features: { gateway: false, storage: 'embedded' },
              theme: { colors: { info: '#123456' } },
            }),
          );
        if (url.endsWith('/api/auth/me'))
          return new Response(
            JSON.stringify({ mode: 'none', provider: null, user: null, token: null, admin: true }),
          );
        if (url.endsWith('/api/notifications?limit=50'))
          return new Response(JSON.stringify({ notifications: [], unread: 0 }));
        if (url.endsWith('/api/inbox')) return new Response(JSON.stringify({ waiting: 0 }));
        return new Response('[]');
      }),
    );
    vi.stubGlobal(
      'WebSocket',
      class {
        readyState = 0;
        close() {}
        send() {}
      },
    );
  });

  it('mounts into an element, talks to the given server, themes and routes inside the host', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const paths: string[] = [];
    let studio!: ReturnType<typeof mountRideo>;
    await act(async () => {
      studio = mountRideo(el, {
        server: 'https://studio.example.com/rideo',
        routing: { mode: 'memory', initialPath: '/' },
        theme: { mode: 'light', colors: { accent: '#7c3aed' }, brand: { name: 'Host Video' } },
        onNavigate: (p) => paths.push(p),
      });
    });
    expect(getRuntime()).toMatchObject({ apiBase: 'https://studio.example.com/rideo/', embedded: true });
    const root = el.querySelector<HTMLElement>('.rideo-root')!;
    expect(root.dataset.theme).toBe('light');
    expect(root.style.getPropertyValue('--color-accent')).toBe('#7c3aed');
    // the studio's own theme (from its server) under the host's
    await waitFor(() => expect(root.style.getPropertyValue('--color-info')).toBe('#123456'));
    expect(calls).toContain('https://studio.example.com/rideo/api/config');
    expect(await screen.findByTestId('studio-name')).toHaveProperty('textContent', 'Host Video');
    // nothing of the host page's document is touched
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(paths).toEqual(['/']);
    await act(async () => studio.navigate('/verify'));
    expect(paths.at(-1)).toBe('/verify');
    await act(async () => studio.setTheme({ mode: 'dark' }));
    expect(el.querySelector<HTMLElement>('.rideo-root')!.dataset.theme).toBe('dark');
    // a person's own choice wins over the theme's default mode
    await act(async () => useUi.getState().setTheme('light'));
    expect(el.querySelector<HTMLElement>('.rideo-root')!.dataset.theme).toBe('light');
    await act(async () => studio.unmount());
    expect(el.querySelector('.rideo-root')).toBeNull();
  });

  it('checks themes and names the tokens they may set', () => {
    expect(defineTheme({ colors: { accent: '#ff0000' } })).toEqual({ colors: { accent: '#ff0000' } });
    expect(() => defineTheme({ colors: { accent: 'red;}' } })).toThrow();
    expect(THEME_TOKENS).toContain('accent-contrast');
  });
});
