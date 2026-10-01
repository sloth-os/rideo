import {
  AUDIO_ROLES,
  type AudioRole,
  type AudioSegment,
  audioSegments,
  type DuckEnvelope,
  duckEnvelope,
  duckPoints,
  type Timeline,
} from '@rideo/shared';
import type { MediaPool } from './media-pool';

/**
 * Schedules the timeline's audio segments on an (Offline)AudioContext from `from` seconds: each decoded
 * buffer gets a gain envelope for volume and fades; speed maps to playbackRate. Segments play into their stem's
 * bus, and the music bus ducks under speech exactly like the render (docs/design/post-audio.md#ducking).
 */
export async function scheduleAudio(
  ctx: BaseAudioContext,
  timeline: Timeline,
  pool: MediaPool,
  from: number,
  startAt: number,
  isCancelled: () => boolean = () => false,
): Promise<AudioScheduledSourceNode[]> {
  const nodes: AudioScheduledSourceNode[] = [];
  const segments = audioSegments(timeline).filter((s) => s.end > from);
  const buses = {} as Record<AudioRole, GainNode>;
  for (const role of AUDIO_ROLES) {
    buses[role] = ctx.createGain();
    buses[role].connect(ctx.destination);
  }
  const duck = duckEnvelope(timeline);
  if (duck) automateDuck(buses.music.gain, duck, from, startAt);
  await Promise.all(
    segments.map((seg) =>
      scheduleSegment(ctx, seg, pool, from, startAt, nodes, isCancelled, buses[seg.role]),
    ),
  );
  return nodes;
}

/** The duck as gain automation from timeline second `from` (played at context time `startAt`). */
export function automateDuck(
  param: Pick<AudioParam, 'setValueAtTime' | 'linearRampToValueAtTime'>,
  env: DuckEnvelope,
  from: number,
  startAt: number,
): void {
  const [first, ...rest] = duckPoints(env, from);
  param.setValueAtTime(first!.gain, startAt);
  for (const p of rest) param.linearRampToValueAtTime(p.gain, startAt + (p.time - from));
}

async function scheduleSegment(
  ctx: BaseAudioContext,
  seg: AudioSegment,
  pool: MediaPool,
  from: number,
  startAt: number,
  nodes: AudioScheduledSourceNode[],
  isCancelled: () => boolean,
  bus: AudioNode,
): Promise<void> {
  const entry = await pool.get(seg.media);
  if (!entry.audio) return;
  const gain = ctx.createGain();
  gain.connect(bus);
  const at = (timelineTime: number) => startAt + (timelineTime - from);
  // Envelope: volume with fade in/out, in context time.
  const t0 = Math.max(seg.start, from);
  const fadeInEnd = seg.start + seg.fadeIn;
  const fadeOutStart = seg.end - seg.fadeOut;
  const level = (t: number) => {
    let v = seg.volume;
    if (seg.fadeIn > 0 && t < fadeInEnd) v *= Math.max(0, (t - seg.start) / seg.fadeIn);
    if (seg.fadeOut > 0 && t > fadeOutStart) v *= Math.max(0, (seg.end - t) / seg.fadeOut);
    return v;
  };
  gain.gain.setValueAtTime(level(t0), at(t0));
  if (seg.fadeIn > 0 && fadeInEnd > t0) gain.gain.linearRampToValueAtTime(seg.volume, at(fadeInEnd));
  if (seg.fadeOut > 0) {
    gain.gain.setValueAtTime(level(Math.max(t0, fadeOutStart)), at(Math.max(t0, fadeOutStart)));
    gain.gain.linearRampToValueAtTime(0, at(seg.end));
  }
  const srcFrom = seg.in + Math.max(0, from - seg.start) * seg.speed;
  for await (const wrapped of entry.audio.buffers(srcFrom, seg.out)) {
    if (isCancelled()) return;
    const node = ctx.createBufferSource();
    node.buffer = wrapped.buffer;
    node.playbackRate.value = seg.speed;
    node.connect(gain);
    const timelineAt = seg.start + (wrapped.timestamp - seg.in) / seg.speed;
    const offset = Math.max(0, (from - timelineAt) * seg.speed);
    const when = at(Math.max(timelineAt, from));
    if (offset >= wrapped.duration) continue;
    const remaining = Math.min(wrapped.duration - offset, seg.out - wrapped.timestamp - offset + 1e-3);
    if (remaining <= 0) continue;
    node.start(Math.max(when, ctx.currentTime), offset, remaining);
    nodes.push(node);
  }
}
