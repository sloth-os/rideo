import { type Character, LINE_HEARD_RATIO, type Shot, type Take, takeState } from '@rideo/shared';
import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, UserCheck } from 'lucide-react';
import { NO_ELEMENTS, useProject } from '../store/project';
import { Badge } from './ui';

/** The consistency state of a take (docs/design/character-consistency.md#what-the-user-sees). */
export function ConsistencyBadge({
  take,
  shot,
  characters,
}: {
  take: Take;
  shot: Pick<Shot, 'characterIds'> & Partial<Pick<Shot, 'elementIds'>>;
  characters: Record<string, Character>;
}) {
  const elements = useProject((s) => s.docs?.elements ?? NO_ELEMENTS);
  const state = takeState(take, shot, characters, elements);
  const judged = take.consistency.characters.length + (take.consistency.elements?.length ?? 0);
  const score = judged ? take.consistency.score.toFixed(2) : null;
  switch (state) {
    case 'passed':
      return (
        <Badge tone="success" title={`Judge: ${take.consistency.judge}`}>
          <ShieldCheck className="size-3" /> passed{score ? ` ${score}` : ''}
        </Badge>
      );
    case 'failed':
      return (
        <Badge
          tone="danger"
          title={[...take.consistency.characters, ...(take.consistency.elements ?? [])]
            .flatMap((c) => c.issues)
            .join('; ')}
        >
          <ShieldX className="size-3" /> failed{score ? ` ${score}` : ''}
        </Badge>
      );
    case 'unverified':
      return (
        <Badge tone="warning" title={take.consistency.note}>
          <ShieldQuestion className="size-3" /> unverified
        </Badge>
      );
    case 'stale':
      return (
        <Badge tone="warning" title="Generated from an older character or element lock — regenerate">
          <ShieldAlert className="size-3" /> stale
        </Badge>
      );
    case 'overridden':
      return (
        <Badge
          tone="info"
          title={`${take.override?.actor.name ?? take.override?.actor.id}: ${take.override?.reason}`}
        >
          <UserCheck className="size-3" /> override
        </Badge>
      );
  }
}

/**
 * The temporal, physics, cast-in-frame and sound checks of a take (docs/design/continuity.md#quality-checks-in-the-gate).
 */
export function QualityBadge({ take }: { take: Take }) {
  const q = take.consistency.quality;
  if (!q) return null;
  const unheard = q.sound?.lines.filter((l) => l.heard < LINE_HEARD_RATIO).length ?? 0;
  const parts = [
    q.temporal?.jumps.length
      ? `jumps at ${q.temporal.jumps.map((t) => `${t.toFixed(1)} s`).join(', ')}`
      : null,
    q.physics !== null ? `physics ${q.physics.toFixed(2)}` : null,
    q.continuity !== null ? `continuity ${q.continuity.toFixed(2)}` : null,
    q.sound?.lines.length ? `${q.sound.lines.length - unheard}/${q.sound.lines.length} lines heard` : null,
    q.sound?.transcript ? `heard: “${q.sound.transcript}”` : null,
  ].filter(Boolean);
  return (
    <Badge
      tone={q.passed ? 'neutral' : 'warning'}
      title={[...parts, ...q.issues].join('; ')}
      testid="quality-badge"
    >
      {q.passed
        ? 'quality ok'
        : q.temporal?.jumps.length
          ? 'jumps'
          : q.extras?.length
            ? 'wrong cast in frame'
            : unheard
              ? 'line not heard'
              : 'physics'}
    </Badge>
  );
}
