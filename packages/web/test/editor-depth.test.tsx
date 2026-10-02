import {
  AnalysisSchema,
  emptyTimeline,
  evaluateWorkflow,
  type TimelineOp,
  TimelineSchema,
  type VideoItem,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawPeaks } from '../src/features/editor/engine/peaks';
import { RampSection, TransformSection } from '../src/features/editor/ItemPanels';
import { TranscriptPanel } from '../src/features/editor/TranscriptPanel';
import { emptySlice, useProject } from '../src/store/project';

afterEach(cleanup);

const footage = f.media({ path: 'media/uploads/talk-0123456789ab.mp4', durationSec: 10, hasAudio: true });
const item = (over: Partial<VideoItem> = {}): VideoItem => ({
  id: 'itm_0000000000a1',
  kind: 'video',
  source: { type: 'media', media: footage },
  start: 2,
  in: 0,
  out: 6,
  speed: 1,
  volume: 1,
  ...over,
});

describe('inspector sections (docs/design/editor.md#editor-ui)', () => {
  it('sets a keyframe at the playhead with the values typed, and applies presets', () => {
    const apply = vi.fn<(ops: TimelineOp[]) => void>();
    render(<TransformSection item={item()} time={3.5} duration={6} apply={apply} />);
    expect((screen.getByTestId('transform-scale') as HTMLInputElement).value).toBe('1');
    fireEvent.change(screen.getByTestId('transform-scale'), { target: { value: '0.4' } });
    fireEvent.click(screen.getByTestId('keyframe-set'));
    expect(apply).toHaveBeenLastCalledWith([
      {
        op: 'set_transform',
        itemId: 'itm_0000000000a1',
        transform: { keyframes: [{ t: 1.5, x: 0.5, y: 0.5, scale: 0.4, rotation: 0, opacity: 1 }] },
      },
    ]);
    fireEvent.change(screen.getByTestId('transform-preset'), { target: { value: 'pip' } });
    expect(apply).toHaveBeenLastCalledWith([
      {
        op: 'set_transform',
        itemId: 'itm_0000000000a1',
        transform: { keyframes: [{ t: 0, x: 0.78, y: 0.22, scale: 0.35 }] },
      },
    ]);
  });

  it('shows the transform in effect and removes the keyframe under the playhead', () => {
    const apply = vi.fn<(ops: TimelineOp[]) => void>();
    const it = item({
      transform: {
        keyframes: [
          { t: 0, scale: 0.5 },
          { t: 2, scale: 1.5 },
        ],
      },
    });
    const { rerender } = render(<TransformSection item={it} time={3} duration={6} apply={apply} />);
    // halfway between the keyframes, interpolated; no keyframe under the playhead
    expect((screen.getByTestId('transform-scale') as HTMLInputElement).value).toBe('1');
    expect(screen.queryByTestId('keyframe-remove')).toBeNull();
    rerender(<TransformSection item={it} time={4} duration={6} apply={apply} />);
    expect((screen.getByTestId('transform-scale') as HTMLInputElement).value).toBe('1.5');
    expect(screen.getByTestId('keyframes').textContent).toContain('◆ 2.00 s');
    fireEvent.click(screen.getByTestId('keyframe-remove'));
    expect(apply).toHaveBeenLastCalledWith([
      { op: 'set_transform', itemId: 'itm_0000000000a1', transform: { keyframes: [{ t: 0, scale: 0.5 }] } },
    ]);
  });

  it('applies ramp presets over the item’s source range and goes back to a constant speed', () => {
    const apply = vi.fn<(ops: TimelineOp[]) => void>();
    const { rerender } = render(<RampSection item={item({ in: 1, out: 5 })} apply={apply} />);
    fireEvent.change(screen.getByTestId('ramp-preset'), { target: { value: 'ease_in' } });
    expect(apply).toHaveBeenLastCalledWith([
      {
        op: 'set_ramp',
        itemId: 'itm_0000000000a1',
        ramp: {
          points: [
            { at: 1, speed: 0.5 },
            { at: 5, speed: 2 },
          ],
        },
      },
    ]);
    rerender(
      <RampSection
        item={item({
          in: 1,
          out: 5,
          ramp: {
            points: [
              { at: 1, speed: 0.5 },
              { at: 5, speed: 2 },
            ],
          },
        })}
        apply={apply}
      />,
    );
    expect(screen.getByText('The item’s own sound is muted while it ramps.'.replace('’', "'"))).toBeTruthy();
    fireEvent.change(screen.getByTestId('ramp-preset'), { target: { value: 'off' } });
    expect(apply).toHaveBeenLastCalledWith([{ op: 'set_ramp', itemId: 'itm_0000000000a1', ramp: null }]);
  });
});

describe('transcript panel (docs/design/editor.md#transcript-editing)', () => {
  beforeEach(() => {
    const resource = {
      id: 'res_0000000000a1',
      kind: 'video' as const,
      role: 'source' as const,
      name: 'talk.mp4',
      media: footage,
      createdAt: '2026-10-01T00:00:00.000Z',
      origin: 'upload' as const,
      status: 'ready' as const,
    };
    const analysis = AnalysisSchema.parse({
      id: 'ana_0000000000a1',
      resourceId: resource.id,
      status: 'completed',
      createdAt: '2026-10-01T00:00:00.000Z',
      transcript: [
        {
          start: 0,
          end: 3,
          text: 'Um, hello there, you know.',
          words: [
            { text: 'Um,', start: 0, end: 0.4 },
            { text: 'hello', start: 0.5, end: 0.9 },
            { text: 'there,', start: 0.9, end: 1.3 },
            { text: 'you', start: 1.4, end: 1.6 },
            { text: 'know.', start: 1.6, end: 2 },
          ],
        },
        { start: 7, end: 9, text: 'Not in the cut.', words: [{ text: 'Not', start: 7.1, end: 7.4 }] },
      ],
    });
    const docs = f.docs({ resources: { [resource.id]: resource }, analyses: { [analysis.id]: analysis } });
    useProject.setState({
      ...emptySlice,
      projectId: docs.project.id,
      docs,
      workflow: evaluateWorkflow(docs),
    });
  });

  it('lists the words of the cut’s sources, removes the fillers in one op and cuts a selection', () => {
    const apply = vi.fn<(ops: TimelineOp[]) => void>();
    const t = TimelineSchema.parse({
      ...emptyTimeline({ fps: 24, width: 320, height: 180 }),
    });
    t.tracks[0]!.items.push(item({ start: 0, in: 0, out: 5 }));
    render(<TranscriptPanel timeline={t} apply={apply} />);
    const words = screen.getAllByTestId('transcript-word');
    expect(words.map((w) => [w.textContent, w.getAttribute('data-in-cut')])).toEqual([
      ['Um,', 'true'],
      ['hello', 'true'],
      ['there,', 'true'],
      ['you', 'true'],
      ['know.', 'true'],
      ['Not', 'false'],
    ]);
    const fillers = screen.getByTestId('transcript-fillers');
    expect(fillers.getAttribute('data-count')).toBe('2');
    fireEvent.click(fillers);
    expect(apply).toHaveBeenLastCalledWith([
      {
        op: 'remove_ranges',
        media: footage.path,
        ranges: [
          [0, 0.43],
          [1.37, 2.03],
        ],
      },
    ]);
    fireEvent.click(words[1]!);
    fireEvent.click(words[2]!, { shiftKey: true });
    fireEvent.click(screen.getByTestId('transcript-cut'));
    expect(apply).toHaveBeenLastCalledWith([
      { op: 'remove_ranges', media: footage.path, ranges: [[0.47, 1.33]] },
    ]);
  });
});

describe('waveforms', () => {
  it('draws the loudest peak of each pixel’s span, centred', () => {
    const rects: number[][] = [];
    const ctx = {
      clearRect: vi.fn(),
      fillRect: (...a: number[]) => rects.push(a),
    } as unknown as CanvasRenderingContext2D;
    const peaks = new Float32Array(200);
    peaks[50] = 1;
    peaks[150] = 0.5;
    drawPeaks(ctx, peaks, 0, 2, 4, 22);
    expect(rects.map((r) => r[3])).toEqual([1, 20, 1, 10]);
    expect(rects[1]).toEqual([1, 1, 1, 20]);
  });
});
