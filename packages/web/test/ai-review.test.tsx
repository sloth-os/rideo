import {
  evaluateWorkflow,
  ProjectSettingsSchema,
  type StageReview,
  StageReviewSchema,
  screenplayReviewSubject,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiReviewPanel } from '../src/features/ai-review/AiReviewPanel';
import { emptySlice, useProject } from '../src/store/project';

/** The AI review panel of the Story and Storyboard views (docs/design/ai-review.md#surfaces). */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = '2026-10-28T00:00:00.000Z';
const screenplay = f.screenplay({
  scenes: [
    {
      id: 'scn_0000000000aaaaaa',
      index: 0,
      beatId: null,
      heading: 'EXT. PIER - DAY',
      location: 'Pier',
      timeOfDay: 'day',
      summary: 'They meet',
      action: 'A crowd of tourists cheers.',
      dialogue: [],
      characterIds: [],
      locationId: null,
      elementIds: [],
      estDurationSec: 30,
      continuity: '',
    },
  ],
});

function failing(subject: string): StageReview {
  return StageReviewSchema.parse({
    stage: 'screenplay',
    status: 'succeeded',
    subject,
    round: 2,
    threshold: 7,
    model: 'qwen3.8-max',
    verdict: { passed: false, score: 6.1, blocking: ['critical: Scene 1 needs a crowd'] },
    scores: { story: 8, feasibility: 3, dialogue: 7 },
    summary: 'A warm premise; one scene cannot be filmed.',
    issues: [
      {
        id: 'i2.1',
        dimension: 'feasibility',
        severity: 'critical',
        title: 'Scene 1 needs a crowd',
        scene: 1,
        sceneId: 'scn_0000000000aaaaaa',
      },
    ],
    recommendations: [
      {
        id: 'r2.1',
        round: 2,
        priority: 1,
        dimension: 'feasibility',
        title: 'Keep scene 1 to its cast',
        action: { kind: 'revise_scene', sceneId: 'scn_0000000000aaaaaa', instruction: 'Remove the crowd.' },
      },
      {
        id: 'r2.2',
        round: 2,
        priority: 3,
        dimension: 'story',
        title: 'Plant the end',
        action: { kind: 'note' },
      },
      {
        id: 'r1',
        round: 1,
        priority: 1,
        dimension: 'continuity',
        title: 'Write the light',
        status: 'applied',
        appliedBy: { kind: 'system', id: 'rideo' },
        action: { kind: 'revise_scene', sceneId: 'scn_0000000000aaaaaa', instruction: 'Morning light.' },
      },
    ],
    history: [{ round: 1, at, score: 5.2, passed: false, issues: 2, applied: 1 }],
    createdAt: at,
    updatedAt: at,
  });
}

let calls: { url: string; method: string; body?: string }[];
function setup(review: StageReview | null, settings = {}) {
  const docs = f.docs({
    project: f.project({ settings: ProjectSettingsSchema.parse(settings) }),
    screenplay,
    aiReviews: review ? { screenplay: review } : {},
  });
  useProject.setState({ ...emptySlice, projectId: docs.project.id, docs, workflow: evaluateWorkflow(docs) });
  return docs;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (url.includes('/run'))
        return new Response(JSON.stringify({ job: { id: 'job_0000000000aaaaaa' } }), { status: 202 });
      if (url.includes('/apply'))
        return new Response(JSON.stringify({ review: {}, job: { id: 'job_0000000000bbbbbb' } }));
      return new Response('{}');
    }),
  );
  vi.stubGlobal(
    'prompt',
    vi.fn(() => 'a painted backdrop'),
  );
});

describe('AI review panel (docs/design/ai-review.md#surfaces)', () => {
  it('shows a failing review: the score against the threshold, what blocks it, the bars and the fixes', async () => {
    const docs = setup(null);
    setup(failing(screenplayReviewSubject(docs)));
    render(<AiReviewPanel stage="screenplay" />);
    const panel = screen.getByTestId('ai-review-screenplay');
    expect(panel.getAttribute('data-state')).toBe('failed');
    expect(screen.getByTestId('ai-review-state').textContent).toBe('Did not pass');
    expect(screen.getByTestId('ai-review-score').textContent).toBe('6.1 / 10 · passes at 7');
    expect(screen.getByTestId('ai-review-blocking').textContent).toContain('Scene 1 needs a crowd');
    expect(screen.getByTestId('ai-review-score-feasibility').textContent).toContain('3.0');
    expect(screen.getByTestId('ai-review-round').textContent).toContain(
      'Round 2 · earlier: 5.2 · qwen3.8-max',
    );
    fireEvent.click(screen.getByTestId('ai-review-details'));
    const recs = screen.getAllByTestId('ai-review-recommendation');
    expect(recs).toHaveLength(3);
    expect(recs[0]!.textContent).toContain('Rewrite scene 1: Remove the crowd.');
    // The fix of the first round stays listed, applied by the review
    expect(recs[2]!.getAttribute('data-status')).toBe('applied');
    expect(recs[2]!.textContent).toContain('applied by the review');
    expect(within(recs[1]!).queryByTestId('apply-ai-review')).toBeNull();
    fireEvent.click(within(recs[0]!).getByTestId('apply-ai-review'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/ai-reviews/screenplay/recommendations/r2.1/apply'))).toBe(
        true,
      ),
    );
    fireEvent.click(within(recs[1]!).getByTestId('dismiss-ai-review'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/recommendations/r2.2/dismiss'))).toBe(true),
    );
    expect(screen.getAllByTestId('ai-review-issue')[0]!.textContent).toContain('Scene 1');
    // Continue anyway, with a reason
    fireEvent.click(screen.getByTestId('override-ai-review'));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith('/ai-reviews/screenplay/override'));
      expect(call?.body).toContain('a painted backdrop');
    });
    fireEvent.click(screen.getByTestId('run-ai-review'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/ai-reviews/screenplay/run'))).toBe(true));
  });

  it('says when the screenplay changed since its review, when none ran yet, and hides itself when off', () => {
    setup(failing('0000'));
    const { unmount } = render(<AiReviewPanel stage="screenplay" />);
    expect(screen.getByTestId('ai-review-state').textContent).toBe('Changed since the review');
    expect(screen.queryByTestId('override-ai-review')).toBeNull();
    unmount();
    setup(null);
    const second = render(<AiReviewPanel stage="screenplay" />);
    expect(screen.getByTestId('ai-review-state').textContent).toBe('Not reviewed yet');
    expect(screen.getByTestId('run-ai-review').textContent).toBe('Review');
    second.unmount();
    setup(null, { review: { screenplay: false } });
    render(<AiReviewPanel stage="screenplay" />);
    expect(screen.queryByTestId('ai-review-screenplay')).toBeNull();
  });
});
