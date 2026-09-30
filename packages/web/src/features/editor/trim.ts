import type { Item, TimelineOp } from '@rideo/shared';

const ms = (v: number) => Math.round(v * 1000) / 1000;

/** Ops for dragging an item edge by `delta` seconds of timeline time (free tracks keep the other edge fixed). */
export function trimOps(item: Item, side: 'start' | 'end', delta: number, free: boolean): TimelineOp[] {
  if (item.kind === 'text') {
    if (side === 'end')
      return [{ op: 'update_text', itemId: item.id, duration: ms(Math.max(0.1, item.duration + delta)) }];
    const d = Math.min(Math.max(delta, -item.start), item.duration - 0.1);
    return [
      { op: 'update_text', itemId: item.id, start: ms(item.start + d), duration: ms(item.duration - d) },
    ];
  }
  const speed = item.kind === 'video' ? item.speed : 1;
  const minLen = 0.1 * speed;
  if (side === 'end') {
    const max = item.source.media.durationSec ?? Number.POSITIVE_INFINITY;
    return [
      {
        op: 'trim',
        itemId: item.id,
        out: ms(Math.min(max, Math.max(item.in + minLen, item.out + delta * speed))),
      },
    ];
  }
  const nextIn = Math.min(Math.max(0, item.in + delta * speed), item.out - minLen);
  const ops: TimelineOp[] = [{ op: 'trim', itemId: item.id, in: ms(nextIn) }];
  if (free)
    ops.push({
      op: 'move',
      itemId: item.id,
      start: ms(Math.max(0, item.start + (nextIn - item.in) / speed)),
    });
  return ops;
}
