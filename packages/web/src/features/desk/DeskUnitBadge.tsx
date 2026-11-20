import { type DeskUnitBadge as Badged, deskUnitBadge, deskUnitDrift } from '@rideo/shared';
import { useMemo } from 'react';
import { Badge, type Tone } from '../../components/ui';
import { useProject } from '../../store/project';

/** The badge's colour: can't use (danger), waiting (warning), available (info), approved (success). */
const TONE: Record<Badged['status'], Tone> = {
  refused: 'danger',
  pending: 'warning',
  update: 'info',
  approved: 'success',
};

/**
 * The Storyboard's 3D badge of a clip (docs/design/director-desk.md#drift-the-storyboard-badge): how the library units
 * pinned on its scene's place, cast and props stand against what its stored desk state uses. Nothing when all is
 * current, made local or not known; the tooltip lists every pinned slot.
 */
export function DeskUnitBadge({ clipId }: { clipId: string }) {
  const docs = useProject((s) => s.docs);
  const badge = useMemo(() => (docs ? deskUnitBadge(deskUnitDrift(docs, clipId)) : null), [docs, clipId]);
  if (!badge) return null;
  return (
    <Badge tone={TONE[badge.status]} title={badge.title} testid="desk-unit-badge">
      <span data-status={badge.status}>{badge.text}</span>
    </Badge>
  );
}
