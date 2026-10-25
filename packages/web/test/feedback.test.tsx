import {
  type Export,
  ExportSchema,
  emptyUsage,
  evaluateWorkflow,
  type Feedback,
  FeedbackSchema,
  type Insights,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackSummary } from '../src/features/exports/FeedbackPanel';
import { InsightsView } from '../src/features/insights/InsightsView';
import {
  flushTelemetry,
  pendingTelemetry,
  recordError,
  recordTiming,
  resetTelemetry,
} from '../src/lib/telemetry';
import { emptySlice, useProject } from '../src/store/project';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetTelemetry();
});

const exportDoc: Export = ExportSchema.parse({
  id: 'exp_0000000000aaaaaa',
  createdAt: '2026-10-25T00:00:00.000Z',
  method: 'browser',
  status: 'succeeded',
  media: f.media({ path: 'media/exports/film-0123456789ab.mp4', durationSec: 25 }),
  durationSec: 25,
});

const feedback: Feedback = FeedbackSchema.parse({
  id: 'fbk_0000000000aaaaaa',
  exportId: exportDoc.id,
  status: 'succeeded',
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:00.000Z',
  model: 'gemini-3.7-flash',
  overall: 6.4,
  scores: {
    storytelling: 7,
    continuity: 6,
    character: 8,
    temporal: 4,
    physics: 5,
    realism: 7,
    cinematography: 7,
    editing: 6,
    sound: 9,
  },
  summary: 'Two pandas ski down a sunny slope; the middle shot jumps.',
  strengths: ['charming cast'],
  scenes: [
    {
      clipId: 'clp_0000000000aaaaaa',
      index: 0,
      title: 'The slope',
      start: 0,
      end: 25,
      scores: { temporal: 4 },
      summary: 'A run.',
    },
  ],
  issues: [
    {
      id: 'i1',
      dimension: 'temporal',
      severity: 'major',
      title: 'The picture jumps inside the shot',
      start: 7.4,
      end: 7.9,
      clipId: 'clp_0000000000aaaaaa',
      shotId: 'sht_0000000000aaaaaa',
      shot: 'C1·S2',
      source: 'signal',
    },
  ],
  recommendations: [
    {
      id: 'r1',
      priority: 1,
      dimension: 'temporal',
      title: 'Generate C1·S2 again',
      detail: 'Steady camera.',
      action: {
        kind: 'regenerate_shot',
        clipId: 'clp_0000000000aaaaaa',
        shotId: 'sht_0000000000aaaaaa',
        action: 'She carves left',
      },
    },
    { id: 'r2', priority: 3, dimension: 'editing', title: 'Trim the last hold', action: { kind: 'note' } },
  ],
  retrospective: [
    {
      area: 'cost',
      title: '40% of the generated video was thrown away',
      detail: '',
      source: 'rule',
      rule: 'discarded_generations',
    },
  ],
  report: f.media({ path: 'media/reports/exp-feedback-0123456789ab.md', mime: 'text/markdown' }),
});

let calls: { url: string; method: string }[];
beforeEach(() => {
  const docs = f.docs({ exports: { [exportDoc.id]: exportDoc }, feedback: { [feedback.id]: feedback } });
  useProject.setState({ ...emptySlice, projectId: docs.project.id, docs, workflow: evaluateWorkflow(docs) });
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/apply'))
        return new Response(
          JSON.stringify({ feedback, job: { id: 'job_0000000000aaaaaa', kind: 'shot.generate' } }),
        );
      if (url.includes('/dismiss')) return new Response(JSON.stringify(feedback));
      if (url.includes('/feedback'))
        return new Response(JSON.stringify({ feedback, job: {} }), { status: 202 });
      return new Response('{}');
    }),
  );
  // jsdom has no media playback
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
});

describe('feedback on the export card (docs/design/feedback.md#surfaces)', () => {
  it('shows the score, a bar per dimension and opens the full feedback', async () => {
    const projectId = useProject.getState().projectId!;
    render(<FeedbackSummary e={exportDoc} projectId={projectId} />);
    expect(screen.getByTestId('feedback-overall').textContent).toBe('6.4/10');
    expect(screen.getByTestId('feedback-score-temporal').textContent).toContain('4.0');
    expect(screen.getByText(/1 issues · 2 open recommendations/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('show-feedback'));
    const dialog = screen.getByTestId('feedback-dialog');
    // Recommendations first: apply the first, dismiss the second.
    const recs = within(dialog).getAllByTestId('feedback-recommendation');
    expect(recs).toHaveLength(2);
    expect(recs[0]!.textContent).toContain('Revised: She carves left');
    fireEvent.click(within(recs[0]!).getByTestId('apply-recommendation'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/recommendations/r1/apply'))).toBe(true));
    fireEvent.click(within(recs[1]!).getByTestId('dismiss-recommendation'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/recommendations/r2/dismiss'))).toBe(true));
    // Issues: play from the issue's time on the export.
    fireEvent.click(within(dialog).getByTestId('feedback-tab-issues'));
    fireEvent.click(within(dialog).getByTestId('play-from-here'));
    const video = within(dialog).getByTestId('feedback-video') as HTMLVideoElement;
    expect(video.currentTime).toBeCloseTo(7.4, 5);
    fireEvent.click(within(dialog).getByTestId('feedback-tab-retrospective'));
    expect(within(dialog).getByTestId('feedback-retrospective').textContent).toContain('thrown away');
    expect((screen.getByTestId('download-feedback-report') as HTMLAnchorElement).href).toContain(
      'media/reports/',
    );
  });

  it('offers feedback on an export without any', async () => {
    useProject.setState({ docs: { ...useProject.getState().docs!, feedback: {} } });
    render(<FeedbackSummary e={exportDoc} projectId={useProject.getState().projectId!} />);
    fireEvent.click(screen.getByTestId('get-feedback'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/exports/${exportDoc.id}/feedback`))).toBe(true),
    );
  });
});

describe('insights (docs/design/observability.md#insights)', () => {
  it('shows cost, time, quality and improvements', async () => {
    const insights: Insights = {
      usage: {
        version: 1,
        projectId: 'prj_0000000000aaaaaa',
        updatedAt: '2026-10-25T00:00:00.000Z',
        totals: {
          ...emptyUsage(),
          costUsd: 12.5,
          videoSeconds: 125,
          images: 30,
          llmCalls: 40,
          byModel: {
            'wan3.0-video-prime': {
              modality: 'video',
              calls: 25,
              seconds: 2000,
              units: 125,
              costUsd: 12.5,
              unpriced: 0,
            },
          },
        },
        byKind: {
          'shot.generate': {
            jobs: 25,
            succeeded: 25,
            failed: 0,
            cancelled: 0,
            runSeconds: 3000,
            waitSeconds: 600,
            costUsd: 12.5,
          },
        },
      },
      jobs: [
        {
          kind: 'shot.generate',
          count: 25,
          succeeded: 25,
          failed: 0,
          cancelled: 0,
          p50Sec: 95,
          p90Sec: 240,
          waitP50Sec: 20,
          errors: {},
        },
      ],
      takes: {
        total: 25,
        passed: 24,
        failed: 0,
        unverified: 1,
        overridden: 0,
        firstTry: 20,
        qualityFailed: 2,
        meanAttempts: 1.3,
      },
      characters: [{ characterId: 'chr_0000000000aaaaaa', name: 'Sammy', checks: 30, failures: 12 }],
      stages: [],
      feedback: [
        {
          exportId: exportDoc.id,
          createdAt: '2026-10-25T00:00:00.000Z',
          overall: 6.4,
          scores: feedback.scores,
        },
      ],
      retrospective: feedback.retrospective,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(insights))),
    );
    render(<InsightsView />);
    await waitFor(() => expect(screen.getByTestId('insights')).toBeTruthy());
    expect(screen.getByTestId('insights-cost-total').textContent).toContain('$12.50');
    // 12.50 for the 25 s export: $30.00 per minute.
    expect(screen.getByTestId('insights-cost').textContent).toContain('$30.00');
    expect(screen.getByTestId('insights-time').textContent).toContain('shot.generate');
    expect(screen.getByTestId('insights-first-try').textContent).toContain('80%');
    expect(screen.getByTestId('insights-quality').textContent).toContain('Sammy: 12/30 failed');
    expect(screen.getByTestId('insights-improvements').textContent).toContain('thrown away');
  });
});

describe('telemetry from the studio (docs/design/observability.md#telemetry-from-the-studio)', () => {
  it('queues timings and errors, sends them in batches of 50 and stops when the server has it off', async () => {
    for (let i = 0; i < 60; i++) recordTiming('export_chunk', 2.5);
    recordError('api');
    expect(pendingTelemetry()).toHaveLength(61);
    const sent: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        expect(init?.keepalive).toBe(true);
        return new Response(null, { status: 204 });
      }),
    );
    await flushTelemetry();
    expect((sent[0] as { events: unknown[] }).events).toHaveLength(50);
    expect(pendingTelemetry()).toHaveLength(11);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    await flushTelemetry();
    recordTiming('project_load', 1);
    expect(pendingTelemetry()).toHaveLength(0);
  });
});
