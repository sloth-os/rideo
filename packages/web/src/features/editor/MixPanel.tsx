import {
  type AudioRole,
  DuckingSchema,
  isTerminalJob,
  type Timeline,
  type TimelineOp,
  trackRole,
} from '@rideo/shared';
import { AudioLines, Music, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { JobRow } from '../../components/JobProgress';
import { Badge, Button, Card, Field, Input, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useConfig } from '../../lib/config';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

const STEM_TONE: Record<AudioRole, 'info' | 'accent' | 'neutral'> = {
  dialogue: 'info',
  music: 'accent',
  effects: 'neutral',
};
const DEPTHS = [-6, -9, -12, -18, -24];

/**
 * The Mix card (docs/design/post-audio.md#surfaces): ducking, the stem of every track, scoring the cut and
 * sound effects from the action lines.
 */
export function MixPanel({ timeline, apply }: { timeline: Timeline; apply: (ops: TimelineOp[]) => void }) {
  const projectId = useProject((s) => s.projectId);
  const allJobs = useProject((s) => s.jobs);
  const cfg = useConfig();
  const [direction, setDirection] = useState('');
  const [busy, setBusy] = useState<'score' | 'sfx' | null>(null);
  const jobs = useMemo(
    () =>
      Object.values(allJobs).filter(
        (j) => (j.kind === 'score.generate' || j.kind === 'sfx.generate') && !isTerminalJob(j),
      ),
    [allJobs],
  );
  if (!projectId) return null;
  const ducking = timeline.mix?.ducking ?? { ...DuckingSchema.parse({}), enabled: false };
  const setDucking = (patch: Partial<typeof ducking>) => apply([{ op: 'set_mix', ducking: patch }]);
  const sfx = cfg?.features.sfx ?? null;
  const run = async (what: 'score' | 'sfx') => {
    setBusy(what);
    try {
      if (what === 'score') await api.scoreCut(projectId, { direction: direction.trim() || undefined });
      else await api.generateEffects(projectId);
      useUi.getState().toast(what === 'score' ? 'Scoring the cut…' : 'Spotting sound effects…', 'info');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };
  const tracks = timeline.tracks.filter((t) => t.kind !== 'text');
  return (
    <Card className="space-y-3 p-3" data-testid="mix-panel">
      <p className="flex items-center gap-1.5 text-[13px] font-medium">
        <AudioLines className="size-4" /> Mix
      </p>
      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <label className="flex h-9 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border bg-surface-2 px-2.5 text-[13px]">
          Duck music under speech
          <input
            type="checkbox"
            checked={ducking.enabled}
            onChange={(e) => setDucking({ enabled: e.target.checked })}
            className="size-4 accent-[var(--color-accent)]"
            data-testid="mix-ducking"
          />
        </label>
        <Field label="Depth">
          <Select
            value={ducking.depthDb}
            disabled={!ducking.enabled}
            onChange={(e) => setDucking({ depthDb: Number(e.target.value) })}
            data-testid="mix-depth"
          >
            {[...new Set([...DEPTHS, ducking.depthDb])]
              .sort((a, b) => b - a)
              .map((d) => (
                <option key={d} value={d}>
                  {d} dB
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <ul className="space-y-1 text-[12px]" data-testid="mix-stems">
        {tracks.map((t) => {
          const role = trackRole(t)!;
          return (
            <li key={t.id} className="flex items-center justify-between gap-2" data-track-id={t.id}>
              <span className="truncate">
                {t.name} <span className="text-muted">· {t.items.length}</span>
              </span>
              <Badge tone={STEM_TONE[role]} testid="track-stem">
                {role}
              </Badge>
            </li>
          );
        })}
      </ul>
      <div className="space-y-2 border-t border-border pt-3">
        <Input
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          placeholder="Score direction (optional): sparse piano, melancholic"
          maxLength={300}
          aria-label="Score direction"
          data-testid="score-direction"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<Music className="size-3.5" />}
            loading={busy === 'score'}
            disabled={jobs.some((j) => j.kind === 'score.generate')}
            onClick={() => run('score')}
            data-testid="score-cut"
          >
            Score the cut
          </Button>
          <Button
            size="sm"
            icon={<Sparkles className="size-3.5" />}
            loading={busy === 'sfx'}
            disabled={!sfx || jobs.some((j) => j.kind === 'sfx.generate')}
            title={sfx ? 'Effects planned from the action lines' : 'No sound-effects provider on this server'}
            onClick={() => run('sfx')}
            data-testid="generate-sfx"
          >
            Add sound effects
          </Button>
        </div>
        <p className="text-[12px] text-muted">
          One cue per scene on the Music track; effects on the Effects track. Both replace what those tracks
          held (History can bring it back).
        </p>
      </div>
      {jobs.map((j) => (
        <JobRow key={j.id} job={j} projectId={projectId} />
      ))}
    </Card>
  );
}
