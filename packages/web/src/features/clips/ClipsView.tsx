import {
  approvedReferences,
  type Character,
  type Clip,
  clipBlockers,
  clipPlannedDuration,
  formatDuration,
  isAcceptable,
  isTerminalJob,
  type Shot,
  sortedClips,
  type Take,
  takeState,
} from '@rideo/shared';
import {
  Check,
  CirclePause,
  Clapperboard,
  Eye,
  Play,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { useState } from 'react';
import { ConsistencyBadge } from '../../components/ConsistencyBadge';
import { Editable } from '../../components/Editable';
import { Entity } from '../../components/Entity';
import { JobRow } from '../../components/JobProgress';
import { MediaImage, MediaVideo } from '../../components/Media';
import {
  Badge,
  Button,
  Card,
  cx,
  Dialog,
  EmptyState,
  Field,
  Progress,
  SectionHeader,
  Textarea,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

function EvidenceDialog({
  take,
  shot,
  characters,
  projectId,
  onClose,
}: {
  take: Take | null;
  shot: Shot | null;
  characters: Record<string, Character>;
  projectId: string;
  onClose: () => void;
}) {
  if (!take || !shot) return null;
  return (
    <Dialog open onClose={onClose} title="Consistency evidence" wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <ConsistencyBadge take={take} shot={shot} characters={characters} />
          <span className="text-muted">
            judge {take.consistency.judge} · threshold {take.consistency.threshold} · attempts{' '}
            {take.consistency.attempts}
          </span>
        </div>
        {take.consistency.note ? <p className="text-[13px] text-muted">{take.consistency.note}</p> : null}
        {take.override ? (
          <p className="rounded bg-info/10 p-2 text-[13px] text-info">
            Override by {take.override.actor.name ?? take.override.actor.id}: “{take.override.reason}”
          </p>
        ) : null}
        {shot.characterIds.map((id) => {
          const c = characters[id];
          const verdict = take.consistency.characters.find((v) => v.characterId === id);
          if (!c) return null;
          return (
            <div key={id}>
              <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">
                {c.name}
                {verdict ? (
                  <Badge
                    tone={
                      verdict.present && verdict.score >= take.consistency.threshold ? 'success' : 'danger'
                    }
                  >
                    {verdict.present ? `score ${verdict.score.toFixed(2)}` : 'not visible'}
                  </Badge>
                ) : null}
                <span className="text-[11px] text-muted">
                  lock v{take.characterLocks[id] ?? '?'} (current v{c.lock.version})
                </span>
              </div>
              <div className="flex gap-2 overflow-x-auto">
                {approvedReferences(c)
                  .slice(0, 3)
                  .map((r) => (
                    <MediaImage
                      key={r.id}
                      projectId={projectId}
                      media={r.media}
                      alt={`${c.name} reference`}
                      className="size-24 shrink-0 rounded border-2 border-success"
                    />
                  ))}
              </div>
              {verdict?.issues.length ? (
                <ul className="mt-1 list-disc pl-5 text-[12px] text-warning">
                  {verdict.issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
        <div>
          <div className="mb-1.5 text-[13px] font-medium">Judged frames</div>
          <div className="flex gap-2 overflow-x-auto">
            {take.consistency.frames.map((f) => (
              <MediaImage
                key={f.hash}
                projectId={projectId}
                media={f}
                alt="judged frame"
                className="h-24 w-auto shrink-0 rounded"
              />
            ))}
            {take.consistency.frames.length === 0 ? (
              <span className="text-[12px] text-muted">No frames recorded.</span>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function OverrideDialog({
  target,
  onClose,
  projectId,
}: {
  target: { clip: Clip; shot: Shot; take: Take } | null;
  onClose: () => void;
  projectId: string;
}) {
  const [reason, setReason] = useState('');
  if (!target) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Accept this take anyway"
      footer={
        <Button
          variant="primary"
          disabled={reason.trim().length < 3}
          onClick={() =>
            api
              .overrideTake(projectId, target.clip.id, target.shot.id, target.take.id, reason)
              .then(onClose)
              .catch(reportError)
          }
          data-testid="confirm-override"
        >
          Record override
        </Button>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        The override and your reason are recorded in the project history. Stale takes cannot be overridden —
        regenerate them.
      </p>
      <Field label="Reason">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Visually verified against the references"
          name="reason"
        />
      </Field>
    </Dialog>
  );
}

function TakeTile({
  clip,
  shot,
  take,
  characters,
  projectId,
  onEvidence,
  onOverride,
}: {
  clip: Clip;
  shot: Shot;
  take: Take;
  characters: Record<string, Character>;
  projectId: string;
  onEvidence: () => void;
  onOverride: () => void;
}) {
  const selected = shot.selectedTakeId === take.id;
  const state = takeState(take, shot, characters);
  return (
    <Entity
      kind="take"
      id={take.id}
      className={cx(
        'w-56 shrink-0 overflow-hidden rounded-[var(--radius-control)] border-2 bg-surface-2',
        selected ? 'border-accent' : 'border-transparent',
      )}
    >
      {take.video ? (
        <MediaVideo projectId={projectId} media={take.video} className="aspect-video w-full" />
      ) : (
        <MediaImage
          projectId={projectId}
          media={take.keyframe}
          alt="keyframe"
          className="aspect-video w-full"
        />
      )}
      <div className="space-y-1.5 p-2">
        <div className="flex flex-wrap items-center gap-1">
          <ConsistencyBadge take={take} shot={shot} characters={characters} />
          {selected ? <Badge tone="accent">selected</Badge> : null}
          {take.watermarkId ? (
            <Badge title={`Invisible watermark ${take.watermarkId}`}>
              <ShieldCheck className="size-3" />
              wm
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          {!selected && take.video ? (
            <Button
              size="sm"
              className="h-7"
              onClick={() => api.selectTake(projectId, clip.id, shot.id, take.id).catch(reportError)}
              data-testid="select-take"
            >
              Select
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            icon={<Eye className="size-3.5" />}
            onClick={onEvidence}
            data-testid="take-evidence"
          >
            Evidence
          </Button>
          {take.video && !isAcceptable(state) && state !== 'stale' ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={onOverride}
              data-testid="override-take"
            >
              Override
            </Button>
          ) : null}
        </div>
      </div>
    </Entity>
  );
}

function ShotRow({
  clip,
  shot,
  characters,
  projectId,
  onEvidence,
  onOverride,
}: {
  clip: Clip;
  shot: Shot;
  characters: Record<string, Character>;
  projectId: string;
  onEvidence: (take: Take) => void;
  onOverride: (take: Take) => void;
}) {
  const job = useProject((s) =>
    Object.values(s.jobs).find(
      (j) => j.kind === 'shot.generate' && j.params.shotId === shot.id && !isTerminalJob(j),
    ),
  );
  const tone =
    shot.status === 'ready'
      ? 'success'
      : shot.status === 'needs_review'
        ? 'warning'
        : shot.status === 'failed'
          ? 'danger'
          : shot.status === 'generating' || shot.status === 'queued'
            ? 'accent'
            : 'neutral';
  return (
    <Entity
      kind="shot"
      id={shot.id}
      className="rounded-[var(--radius-control)] border border-border p-3"
      as="div"
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="tabular font-medium">Shot {shot.index + 1}</span>
        <Badge tone={tone}>{shot.status.replace('_', ' ')}</Badge>
        <Badge>{formatDuration(shot.durationSec)}</Badge>
        <Badge>
          {shot.camera.framing.replace('_', ' ')} · {shot.camera.movement.replace('_', ' ')}
        </Badge>
        {shot.continuity === 'continuous' ? <Badge tone="info">continuous</Badge> : null}
        {shot.characterIds.map((id) => (
          <Badge key={id} tone="info">
            {characters[id]?.name ?? id}
          </Badge>
        ))}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCcw className="size-3.5" />}
          disabled={!!job}
          onClick={() => api.regenerateShot(projectId, clip.id, shot.id).catch(reportError)}
          data-testid="regenerate-shot"
        >
          {shot.takes.length ? 'New take' : 'Generate'}
        </Button>
      </div>
      <div className="mt-2">
        <Editable
          value={shot.description}
          multiline
          rows={2}
          onSave={(v) => api.updateShot(projectId, clip.id, shot.id, { description: v })}
          ariaLabel="Shot description"
        />
      </div>
      {shot.lastError ? <p className="mt-1 text-[12px] text-danger">{shot.lastError}</p> : null}
      {job ? (
        <div className="mt-2">
          <JobRow job={job} projectId={projectId} compact />
        </div>
      ) : null}
      {shot.takes.length ? (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {[...shot.takes].reverse().map((t) => (
            <TakeTile
              key={t.id}
              clip={clip}
              shot={shot}
              take={t}
              characters={characters}
              projectId={projectId}
              onEvidence={() => onEvidence(t)}
              onOverride={() => onOverride(t)}
            />
          ))}
        </div>
      ) : null}
    </Entity>
  );
}

function ClipCard({
  clip,
  characters,
  projectId,
}: {
  clip: Clip;
  characters: Record<string, Character>;
  projectId: string;
}) {
  const [evidence, setEvidence] = useState<{ shot: Shot; take: Take } | null>(null);
  const [override, setOverride] = useState<{ clip: Clip; shot: Shot; take: Take } | null>(null);
  const job = useProject((s) =>
    Object.values(s.jobs).find(
      (j) => j.kind === 'clip.generate' && j.params.clipId === clip.id && !isTerminalJob(j),
    ),
  );
  const blockers = clipBlockers(clip, characters);
  const pending = clip.shots.some((s) => !s.takes.length);
  return (
    <Entity
      kind="clip"
      id={clip.id}
      as="section"
      className="rounded-[var(--radius-card)] border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="tabular text-[12px] text-muted">Clip {clip.index + 1}</span>
            <Badge
              tone={
                clip.status === 'approved'
                  ? 'success'
                  : clip.status === 'review'
                    ? 'accent'
                    : clip.status === 'generating'
                      ? 'warning'
                      : 'neutral'
              }
            >
              {clip.status}
            </Badge>
            <span className="tabular text-[12px] text-muted">
              {formatDuration(clipPlannedDuration(clip))}
            </span>
          </div>
          <h3 className="truncate font-medium">{clip.title}</h3>
        </div>
        {pending ? (
          <Button
            size="sm"
            icon={<Sparkles className="size-3.5" />}
            disabled={!!job}
            onClick={() => api.generateClip(projectId, clip.id).catch(reportError)}
            data-testid="generate-clip"
          >
            Generate
          </Button>
        ) : null}
        {clip.status === 'approved' ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Undo2 className="size-3.5" />}
            onClick={() => api.unapproveClip(projectId, clip.id).catch(reportError)}
          >
            Reopen
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon={<Check className="size-3.5" />}
            disabled={blockers.length > 0}
            title={blockers.map((b) => b.message).join('\n')}
            onClick={() =>
              api
                .approveClip(projectId, clip.id)
                .then(() => useUi.getState().toast(`Clip ${clip.index + 1} approved`, 'success'))
                .catch(reportError)
            }
            data-testid="approve-clip"
          >
            Approve
          </Button>
        )}
      </div>
      <div className="space-y-2 p-3">
        {job ? <JobRow job={job} projectId={projectId} /> : null}
        {blockers.length && !pending ? (
          <ul className="space-y-0.5 text-[12px] text-warning" data-testid="clip-blockers">
            {blockers.map((b) => (
              <li key={`${b.shotId}${b.takeId ?? ''}`}>• {b.message}</li>
            ))}
          </ul>
        ) : null}
        {[...clip.shots]
          .sort((a, b) => a.index - b.index)
          .map((s) => (
            <ShotRow
              key={s.id}
              clip={clip}
              shot={s}
              characters={characters}
              projectId={projectId}
              onEvidence={(take) => setEvidence({ shot: s, take })}
              onOverride={(take) => setOverride({ clip, shot: s, take })}
            />
          ))}
      </div>
      <EvidenceDialog
        take={evidence?.take ?? null}
        shot={evidence?.shot ?? null}
        characters={characters}
        projectId={projectId}
        onClose={() => setEvidence(null)}
      />
      <OverrideDialog target={override} projectId={projectId} onClose={() => setOverride(null)} />
    </Entity>
  );
}

export function ClipsView() {
  const { docs, projectId, workflow, jobs } = useProject();
  if (!docs || !projectId || !workflow) return null;
  const clips = sortedClips(docs);
  const batch = Object.values(jobs).find((j) => j.kind === 'batch.generate' && !isTerminalJob(j));
  const planning = Object.values(jobs).filter((j) => j.kind === 'clip.plan' && !isTerminalJob(j));
  const unplanned = (docs.screenplay?.scenes ?? [])
    .filter((s) => !clips.some((c) => c.sceneId === s.id))
    .sort((a, b) => a.index - b.index);
  const stageGate = workflow.stages[workflow.stageIndex]?.gate;
  const showGate = (workflow.stage === 'pilot' || workflow.stage === 'production') && stageGate;
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SectionHeader
        title="Clips"
        subtitle="Each clip is 10 s – 3 min. Every take passes the consistency gate before it can be approved."
        actions={
          <>
            {batch ? (
              <Button
                icon={<CirclePause className="size-4" />}
                onClick={() => api.pauseBatch(projectId).catch(reportError)}
                data-testid="pause-batch"
              >
                Pause batch
              </Button>
            ) : workflow.stage === 'production' || clips.some((c) => c.status === 'approved') ? (
              <Button
                icon={<Play className="size-4" />}
                onClick={() => api.startBatch(projectId).catch(reportError)}
                data-testid="start-batch"
              >
                Generate remaining
              </Button>
            ) : null}
            {showGate ? (
              <Button
                variant="primary"
                icon={<Check className="size-4" />}
                disabled={!stageGate.satisfied}
                onClick={() =>
                  api
                    .approve(projectId, stageGate.id)
                    .then(() => useUi.getState().toast(`${stageGate.title}: approved`, 'success'))
                    .catch(reportError)
                }
                data-testid="approve-stage"
              >
                {stageGate.title}
              </Button>
            ) : null}
          </>
        }
      />
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <span className="font-medium">Film length</span>
          <span className="tabular text-muted">
            {formatDuration(workflow.approvedDurationSec)} approved ·{' '}
            {formatDuration(workflow.plannedDurationSec)} planned ·{' '}
            {formatDuration(workflow.targetDurationSec)} target
          </span>
        </div>
        <Progress
          value={workflow.plannedDurationSec / Math.max(1, workflow.targetDurationSec)}
          label="planned"
        />
        <div className="mt-1.5">
          <Progress
            value={workflow.approvedDurationSec / Math.max(1, workflow.targetDurationSec)}
            tone="success"
            label="approved"
          />
        </div>
        {batch ? (
          <div className="mt-3">
            <JobRow job={batch} projectId={projectId} />
          </div>
        ) : null}
      </Card>
      {planning.map((j) => (
        <JobRow key={j.id} job={j} projectId={projectId} />
      ))}
      {unplanned.length ? (
        <Card className="p-4">
          <h3 className="mb-2 text-[13px] font-medium">Scenes without clips</h3>
          <ul className="space-y-1.5">
            {unplanned.slice(0, 8).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="tabular text-muted">{s.index + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{s.heading}</span>
                <Button
                  size="sm"
                  onClick={() => api.planClip(projectId, s.id).catch(reportError)}
                  data-testid="plan-scene"
                >
                  Plan
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Clapperboard className="size-3.5" />}
                  onClick={() => api.planClip(projectId, s.id, true).catch(reportError)}
                  data-testid="plan-generate-scene"
                >
                  Plan &amp; generate
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {clips.length === 0 ? (
        <EmptyState icon={<Clapperboard className="size-8" />} title="No clips yet">
          Plan the first scene to create the pilot clip.
        </EmptyState>
      ) : (
        <div className="space-y-4" data-testid="clips">
          {clips.map((c) => (
            <ClipCard key={c.id} clip={c} characters={docs.characters} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}
