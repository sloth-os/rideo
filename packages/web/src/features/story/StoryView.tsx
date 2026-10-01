import { formatDuration, isTerminalJob, type Scene } from '@rideo/shared';
import {
  Check,
  Clapperboard,
  ImagePlus,
  PenLine,
  Plus,
  RefreshCcw,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Editable } from '../../components/Editable';
import { ElementPicker } from '../../components/ElementPicker';
import { Entity } from '../../components/Entity';
import { JobRow } from '../../components/JobProgress';
import { MediaImage, MediaVideo } from '../../components/Media';
import { Badge, Button, Card, EmptyState, Field, SectionHeader, Select, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

function BriefEditor() {
  const { docs, projectId, jobs } = useProject();
  const [prompt, setPrompt] = useState(docs?.project.brief.prompt ?? '');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!docs || !projectId) return null;
  const attachments = docs.project.brief.attachmentResourceIds
    .map((id) => docs.resources[id])
    .filter((r) => !!r);
  const running = Object.values(jobs).find((j) => j.kind === 'screenplay.generate' && !isTerminalJob(j));
  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const ids = [...docs.project.brief.attachmentResourceIds];
      for (const f of Array.from(files)) ids.push((await api.upload(projectId, f, { role: 'reference' })).id);
      await api.updateProject(projectId, { brief: { attachmentResourceIds: ids } });
    } catch (err) {
      reportError(err);
    }
  };
  const generate = async () => {
    setBusy(true);
    try {
      await api.generateScreenplay(projectId, {
        prompt,
        attachmentResourceIds: docs.project.brief.attachmentResourceIds,
      });
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4" data-testid="brief">
      <Field
        label="Your idea"
        hint="Describe the story, tone and world. Reference images and videos shape the look and the cast."
      >
        <Textarea
          value={prompt}
          rows={5}
          name="brief"
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() =>
            prompt !== docs.project.brief.prompt &&
            api.updateProject(projectId, { brief: { prompt } }).catch(reportError)
          }
          placeholder="A lighthouse keeper starts receiving letters from the future…"
        />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        {attachments.map((r) => (
          <div
            key={r.id}
            className="relative size-20 overflow-hidden rounded-[var(--radius-control)] border border-border"
            title={r.name}
          >
            {r.kind === 'image' ? (
              <MediaImage projectId={projectId} media={r.media} alt={r.name} className="size-full" />
            ) : (
              <MediaVideo projectId={projectId} media={r.media} controls={false} className="size-full" />
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex size-20 flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border border-dashed border-border text-[11px] text-muted hover:border-accent hover:text-text"
        >
          <ImagePlus className="size-5" /> Attach
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => attach(e.target.files)}
          data-testid="brief-attach"
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          icon={<Sparkles className="size-4" />}
          loading={busy || !!running}
          disabled={prompt.trim().length < 3}
          onClick={generate}
          data-testid="generate-screenplay"
        >
          Generate screenplay &amp; cast
        </Button>
        <span className="text-[12px] text-muted">
          Target {formatDuration(docs.project.settings.targetDurationSec)} · pilot{' '}
          {formatDuration(docs.project.settings.pilotDurationSec)}
        </span>
      </div>
      {running ? (
        <div className="mt-3">
          <JobRow job={running} projectId={projectId} />
        </div>
      ) : null}
    </Card>
  );
}

function SceneCard({ scene }: { scene: Scene }) {
  const { docs, projectId } = useProject();
  if (!docs || !projectId) return null;
  const clip = Object.values(docs.clips).find((c) => c.sceneId === scene.id);
  const save = (patch: Partial<Scene>) =>
    api.patchScreenplay(
      projectId,
      { upsertScenes: [{ id: scene.id, heading: scene.heading, ...patch }] },
      `scene:${scene.id}`,
    );
  return (
    <Entity
      kind="scene"
      id={scene.id}
      as="article"
      className="rounded-[var(--radius-card)] border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular text-[12px] text-muted">{scene.index + 1}.</span>
        <div className="min-w-0 flex-1">
          <Editable
            value={scene.heading}
            onSave={(v) => save({ heading: v })}
            className="font-mono text-[13px] uppercase"
            ariaLabel="Scene heading"
          />
        </div>
        <Badge>{formatDuration(scene.estDurationSec)}</Badge>
        {clip ? (
          <Badge tone={clip.status === 'approved' ? 'success' : 'accent'}>
            clip {clip.index + 1}: {clip.status}
          </Badge>
        ) : (
          <Button
            size="sm"
            icon={<Clapperboard className="size-3.5" />}
            onClick={() => api.planClip(projectId, scene.id).catch(reportError)}
            data-testid="plan-clip"
          >
            Plan clip
          </Button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {scene.characterIds.map((id) => (
          <Badge key={id} tone="info">
            {docs.characters[id]?.name ?? id}
          </Badge>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
        <Select
          value={scene.locationId ?? ''}
          onChange={(e) => save({ locationId: e.target.value || null })}
          className="h-7 w-auto px-2 text-[12px]"
          aria-label="Scene location"
          data-testid="scene-location"
        >
          <option value="">No location</option>
          {Object.values(docs.elements)
            .filter((e) => e.kind === 'location')
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.lock.locked ? ' 🔒' : ''}
              </option>
            ))}
        </Select>
        <ElementPicker
          value={scene.elementIds}
          kinds={['prop', 'style']}
          label="prop or style"
          onChange={(ids) => save({ elementIds: ids })}
          testid="scene-elements"
        />
      </div>
      <div className="mt-3 space-y-2">
        <Editable
          multiline
          rows={2}
          value={scene.summary}
          placeholder="Summary"
          onSave={(v) => save({ summary: v })}
        />
        <Editable
          multiline
          rows={4}
          value={scene.action}
          placeholder="Action"
          onSave={(v) => save({ action: v })}
        />
      </div>
      {scene.dialogue.length ? (
        <div className="mt-3 space-y-1.5 border-l-2 border-border pl-3">
          {scene.dialogue.map((d, i) => (
            <div key={i} className="text-[13px]">
              <span className="font-semibold uppercase">
                {(d.characterId && docs.characters[d.characterId]?.name) || d.character}
              </span>
              {d.parenthetical ? <span className="text-muted"> ({d.parenthetical})</span> : null}
              <div className="text-muted">{d.line}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 className="size-3.5" />}
          onClick={() =>
            confirm('Remove this scene?') &&
            api.patchScreenplay(projectId, { removeSceneIds: [scene.id] }).catch(reportError)
          }
        >
          Remove
        </Button>
      </div>
    </Entity>
  );
}

export function StoryView() {
  const { docs, projectId, workflow, jobs } = useProject();
  if (!docs || !projectId) return null;
  const sp = docs.screenplay;
  const extending = Object.values(jobs).find((j) => j.kind === 'screenplay.extend' && !isTerminalJob(j));
  const gate = workflow?.stages.find((s) => s.id === 'screenplay')?.gate;
  const atScreenplay = workflow?.stage === 'screenplay';
  const saveFields = (fields: Record<string, unknown>) =>
    api.patchScreenplay(projectId, { fields }, 'doc:screenplay.json');
  if (!sp) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <SectionHeader
          title="Story"
          subtitle="Start from a short idea; Rideo writes the screenplay, a full-length outline and a cast."
        />
        <BriefEditor />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <SectionHeader
        title="Screenplay"
        subtitle={`${sp.scenes.length} scene(s) written · ${sp.outline.length} outline beat(s)`}
        actions={
          <>
            <Button
              icon={<RefreshCcw className="size-4" />}
              onClick={() =>
                confirm('Rewrite the screenplay from the brief? The current version stays in history.') &&
                api.generateScreenplay(projectId).catch(reportError)
              }
            >
              Regenerate
            </Button>
            {atScreenplay && gate ? (
              <Button
                variant="primary"
                icon={<Check className="size-4" />}
                disabled={!gate.satisfied}
                onClick={() =>
                  api
                    .approve(projectId, 'screenplay_approved')
                    .then(() => useUi.getState().toast('Screenplay approved', 'success'))
                    .catch(reportError)
                }
                data-testid="approve-screenplay"
              >
                Approve screenplay
              </Button>
            ) : null}
          </>
        }
      />
      <Card className="space-y-3 p-4">
        <Field label="Title">
          <Editable
            value={sp.title}
            onSave={(v) => saveFields({ title: v })}
            className="text-base font-semibold"
            name="title"
          />
        </Field>
        <Field label="Logline">
          <Editable
            value={sp.logline}
            onSave={(v) => saveFields({ logline: v })}
            multiline
            rows={2}
            name="logline"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Genre">
            <Editable value={sp.genre} onSave={(v) => saveFields({ genre: v })} />
          </Field>
          <Field label="Tone">
            <Editable value={sp.tone} onSave={(v) => saveFields({ tone: v })} />
          </Field>
        </div>
        <Field label="Synopsis">
          <Editable value={sp.synopsis} onSave={(v) => saveFields({ synopsis: v })} multiline rows={3} />
        </Field>
      </Card>
      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-2 font-medium">
          <PenLine className="size-4 text-muted" /> Style bible
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['visual', 'palette', 'camera', 'lighting'] as const).map((k) => (
            <Field key={k} label={k}>
              <Editable
                value={sp.style[k]}
                onSave={(v) => saveFields({ style: { [k]: v } })}
                multiline
                rows={2}
              />
            </Field>
          ))}
        </div>
      </Card>
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">Outline</h3>
          <Button
            size="sm"
            icon={<Wand2 className="size-3.5" />}
            loading={!!extending}
            disabled={sp.outline.every((b) => b.sceneId)}
            onClick={() => api.extendScreenplay(projectId).catch(reportError)}
          >
            Write next scenes
          </Button>
        </div>
        <ol className="space-y-1.5">
          {[...sp.outline]
            .sort((a, b) => a.index - b.index)
            .map((b) => (
              <Entity
                key={b.id}
                kind="beat"
                id={b.id}
                as="li"
                className="flex items-start gap-2 rounded px-1 text-[13px]"
              >
                <span className="tabular w-6 shrink-0 text-muted">{b.index + 1}.</span>
                <span className="min-w-0 flex-1">
                  {b.title ? <span className="font-medium">{b.title} — </span> : null}
                  {b.summary}
                </span>
                <span className="tabular shrink-0 text-[12px] text-muted">
                  {formatDuration(b.estDurationSec)}
                </span>
                {b.sceneId ? (
                  <Check className="size-4 shrink-0 text-success" aria-label="written" />
                ) : (
                  <span className="size-4 shrink-0" />
                )}
              </Entity>
            ))}
        </ol>
      </Card>
      <div className="space-y-3" data-testid="scenes">
        {[...sp.scenes]
          .sort((a, b) => a.index - b.index)
          .map((s) => (
            <SceneCard key={s.id} scene={s} />
          ))}
        {sp.scenes.length === 0 ? <EmptyState title="No scenes yet" /> : null}
        <Button
          icon={<Plus className="size-4" />}
          onClick={() =>
            api
              .patchScreenplay(projectId, {
                upsertScenes: [{ heading: 'INT. NEW SCENE - DAY', estDurationSec: 60 }],
              })
              .catch(reportError)
          }
        >
          Add scene
        </Button>
      </div>
    </div>
  );
}
