import type { TelemetryEvent } from '@rideo/shared';
import { getToken, setServerErrorHandler } from './api';
import { useConfigStore } from './config';
import { apiUrl } from './runtime';

/**
 * Telemetry from the studio (docs/design/observability.md#telemetry-from-the-studio): Core Web Vitals, the waits people
 * notice and error counts, batched every 15 s and when the page is hidden. Names come from fixed lists; nothing about
 * projects or people is sent.
 */
const FLUSH_MS = 15_000;
const MAX_QUEUE = 200;

let queue: TelemetryEvent[] = [];
let started = false;
let enabled = true;
let timer: ReturnType<typeof setInterval> | null = null;
let cls = 0;
let inp = 0;

function route(): string {
  // The view, not the ids: `/projects/:id/editor` → `editor`.
  const parts = (typeof location !== 'undefined' ? location.pathname : '').split('/').filter(Boolean);
  const view = parts[parts.length - 1] ?? '';
  return /^[a-z]+$/.test(view) ? view : 'project';
}

function push(e: TelemetryEvent): void {
  if (!enabled || queue.length >= MAX_QUEUE) return;
  queue.push({ ...e, value: Math.max(0, Math.min(86_400, Number.isFinite(e.value) ? e.value : 0)) });
}

/** A wait people notice (docs/design/observability.md#telemetry-from-the-studio), in seconds. */
export function recordTiming(
  name: 'project_load' | 'editor_ready' | 'first_frame' | 'export_chunk',
  seconds: number,
): void {
  push({ kind: 'timing', name, value: seconds, route: route() });
}

/** An error people may have seen: uncaught, a rejected promise, or an API answer of 5xx. */
export function recordError(name: 'error' | 'rejection' | 'api'): void {
  push({ kind: 'error', name, value: 1, route: route() });
}

export async function flushTelemetry(): Promise<void> {
  if (!queue.length || !enabled) return;
  const events = queue.slice(0, 50);
  queue = queue.slice(50);
  const token = getToken();
  try {
    const res = await fetch(apiUrl('/telemetry'), {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ events }),
    });
    // Off on the server: stop sending.
    if (res.status === 404) enabled = false;
  } catch {
    // Telemetry never gets in the way: drop the batch.
  }
}

function observe(
  type: string,
  fn: (entries: PerformanceEntryList) => void,
  opts: PerformanceObserverInit = {},
): void {
  try {
    const po = new PerformanceObserver((list) => fn(list.getEntries()));
    po.observe({ type, buffered: true, ...opts });
  } catch {
    // An entry type this browser does not have.
  }
}

/** Starts collecting once per page; a server with `RIDEO_TELEMETRY=off` turns it off. */
export function startTelemetry(): void {
  if (started || typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;
  started = true;
  void useConfigStore
    .getState()
    .load()
    .then((c) => {
      if (c.features.telemetry === false) {
        enabled = false;
        queue = [];
      }
    })
    .catch(() => undefined);
  observe('paint', (entries) => {
    for (const e of entries)
      if (e.name === 'first-contentful-paint')
        push({ kind: 'vital', name: 'fcp', value: e.startTime / 1000 });
  });
  let lcp = 0;
  observe('largest-contentful-paint', (entries) => {
    for (const e of entries) lcp = Math.max(lcp, e.startTime);
  });
  observe('layout-shift', (entries) => {
    for (const e of entries as (PerformanceEntry & { value?: number; hadRecentInput?: boolean })[])
      if (!e.hadRecentInput) cls += e.value ?? 0;
  });
  observe(
    'event',
    (entries) => {
      for (const e of entries) inp = Math.max(inp, e.duration);
    },
    { durationThreshold: 40 } as PerformanceObserverInit,
  );
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav?.responseStart) push({ kind: 'vital', name: 'ttfb', value: nav.responseStart / 1000 });
  setServerErrorHandler(() => recordError('api'));
  window.addEventListener('error', () => recordError('error'));
  window.addEventListener('unhandledrejection', () => recordError('rejection'));
  let vitalsSent = false;
  const finalVitals = () => {
    if (vitalsSent) return;
    vitalsSent = true;
    if (lcp) push({ kind: 'vital', name: 'lcp', value: lcp / 1000 });
    push({ kind: 'vital', name: 'cls', value: Math.round(cls * 1000) / 1000 });
    if (inp) push({ kind: 'vital', name: 'inp', value: inp / 1000 });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    finalVitals();
    void flushTelemetry();
  });
  // LCP settles once the page is used; report the vitals after the first minute of a long session too.
  setTimeout(finalVitals, 60_000);
  timer = setInterval(() => void flushTelemetry(), FLUSH_MS);
}

/** Tests: forget everything. */
export function resetTelemetry(): void {
  queue = [];
  started = false;
  enabled = true;
  cls = 0;
  inp = 0;
  if (timer) clearInterval(timer);
  timer = null;
}

/** Tests: what would be sent. */
export function pendingTelemetry(): readonly TelemetryEvent[] {
  return queue;
}
