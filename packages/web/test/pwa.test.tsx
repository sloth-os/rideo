import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Inbox } from '@rideo/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxPage } from '../src/features/inbox/InboxPage';
import { usePwa } from '../src/pwa/register';
import { notificationOf, SHELL_FILES, strategyFor } from '../src/pwa/sw-strategy';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const origin = 'https://studio.example.com';
const at = (path: string) => new URL(path, origin);

describe('the app shell (docs/design/pwa.md#the-app-shell)', () => {
  it('keeps pages and hashed files, never live data or the ffmpeg cores', () => {
    expect(strategyFor(at('/p/prj_1/editor'), origin, 'GET', 'navigate')).toBe('network-first-shell');
    expect(strategyFor(at('/assets/index-abc.js'), origin, 'GET', 'no-cors')).toBe('cache-first');
    expect(strategyFor(at('/assets/ffmpeg-core-abc.wasm'), origin, 'GET', 'cors')).toBe('network');
    expect(strategyFor(at('/api/projects'), origin, 'GET', 'cors')).toBe('network');
    expect(strategyFor(at('/api/projects/prj_1/media/media/a.mp4'), origin, 'GET', 'no-cors')).toBe(
      'network',
    );
    expect(strategyFor(at('/mcp'), origin, 'GET', 'cors')).toBe('network');
    expect(strategyFor(at('/dav/rideo/x'), origin, 'GET', 'cors')).toBe('network');
    expect(strategyFor(at('/assets/index-abc.js'), origin, 'POST', 'cors')).toBe('network');
    expect(strategyFor(new URL('https://fonts.example.net/a.css'), origin, 'GET', 'no-cors')).toBe('network');
  });

  it('shows pushed messages, opening only links of the app', () => {
    expect(
      notificationOf({
        title: 'Export ready',
        body: 'The Keeper',
        link: '/p/prj_1/exports',
        tag: 'job:prj_1',
      }),
    ).toEqual({
      title: 'Export ready',
      options: {
        body: 'The Keeper',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag: 'job:prj_1',
        data: { link: '/p/prj_1/exports' },
      },
    });
    expect(notificationOf({ title: 'x', link: 'https://evil.example/' }).options.data.link).toBe('/inbox');
    expect(notificationOf(null).title).toBe('Rideo');
  });

  it('has a manifest an installable app needs, with its icons', () => {
    const pub = resolve(import.meta.dirname, '../public');
    const m = JSON.parse(readFileSync(resolve(pub, 'manifest.webmanifest'), 'utf8'));
    expect(m).toMatchObject({
      name: 'Rideo Studio',
      short_name: 'Rideo',
      start_url: '/',
      display: 'standalone',
    });
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
    for (const icon of [...m.icons, ...m.shortcuts.flatMap((s: { icons: unknown[] }) => s.icons)])
      expect(existsSync(resolve(pub, `.${(icon as { src: string }).src}`))).toBe(true);
    for (const f of SHELL_FILES.filter((f) => f !== '/'))
      expect(existsSync(resolve(pub, `.${f}`))).toBe(true);
  });
});

const inbox: Inbox = {
  approvals: [
    {
      project: { id: 'prj_000000000001', title: 'The Keeper' },
      stage: 'screenplay',
      gate: { id: 'screenplay_approved', title: 'Approve screenplay' },
    },
  ],
  reviews: [
    {
      project: { id: 'prj_000000000002', title: 'Harbour' },
      review: {
        id: 'rvw_000000000001',
        title: 'Pilot cut',
        createdBy: 'Mira',
        createdAt: new Date().toISOString(),
        gate: null,
      },
    },
  ],
  jobs: [
    {
      project: { id: 'prj_000000000001', title: 'The Keeper' },
      job: {
        id: 'job_000000000001',
        kind: 'batch.generate',
        status: 'running',
        progress: { done: 1, total: 4, message: 'clip 2/4' },
        actor: {
          kind: 'agent',
          id: 'tok_1',
          name: 'Claude Code',
          onBehalfOf: { kind: 'user', id: 'u1', name: 'Mira' },
        },
        createdAt: new Date().toISOString(),
        error: null,
      },
      canCancel: true,
    },
    {
      project: { id: 'prj_000000000002', title: 'Harbour' },
      job: {
        id: 'job_000000000002',
        kind: 'export.finish',
        status: 'failed',
        progress: { done: 0, total: 1 },
        actor: { kind: 'user', id: 'u1', name: 'Mira' },
        createdAt: new Date().toISOString(),
        error: 'watermark failed',
      },
      canCancel: false,
    },
  ],
  agents: [
    {
      project: { id: 'prj_000000000001', title: 'The Keeper' },
      commit: { id: 'c1', message: 'Plan clip 1', at: new Date().toISOString(), agent: 'Claude Code' },
    },
  ],
  waiting: 2,
};

describe('the Inbox (docs/design/pwa.md#the-inbox)', () => {
  let calls: { url: string; method: string }[];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        if (url.startsWith('/api/inbox')) return new Response(JSON.stringify(inbox));
        return new Response('{}');
      }),
    );
  });

  it('approves gates, opens reviews, cancels jobs, and shows what agents did', async () => {
    usePwa.setState({ installable: true, standalone: false, install: async () => undefined });
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(await screen.findAllByTestId('inbox-approval')).toHaveLength(1);
    expect(screen.getByTestId('inbox-open-review').getAttribute('href')).toBe(
      '/p/prj_000000000002/overview?review=rvw_000000000001',
    );
    const jobs = screen.getAllByTestId('inbox-job');
    expect(jobs.map((j) => j.dataset.status)).toEqual(['running', 'failed']);
    expect(jobs[0]?.textContent).toContain('agent');
    expect(jobs[1]?.textContent).toContain('watermark failed');
    expect(screen.getByTestId('inbox-agent').textContent).toContain('Plan clip 1');
    expect(screen.getByTestId('install-app')).toBeTruthy();

    fireEvent.click(screen.getByTestId('inbox-approve'));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/projects/prj_000000000001/workflow/approve',
        method: 'POST',
      }),
    );
    fireEvent.click(screen.getByTestId('inbox-cancel'));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/api/projects/prj_000000000001/jobs/job_000000000001/cancel',
        method: 'POST',
      }),
    );
  });
});
