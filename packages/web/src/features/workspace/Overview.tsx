import {
  type DialogueMode,
  formatDuration,
  isTerminalJob,
  type ProjectSettings,
  workflowFor,
} from '@rideo/shared';
import { Bot, Check, CircleAlert, Copy, FolderSync, RotateCcw, Settings2, X } from 'lucide-react';
import { useState } from 'react';
import { JobRow } from '../../components/JobProgress';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Progress,
  SectionHeader,
  Select,
} from '../../components/ui';
import { WorkflowStepper } from '../../components/WorkflowStepper';
import { api } from '../../lib/api';
import { useConfig } from '../../lib/config';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

function SettingsDialog({
  open,
  onClose,
  settings,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  settings: ProjectSettings;
  projectId: string;
}) {
  const [s, setS] = useState(settings);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.updateProject(projectId, {
        settings: {
          targetDurationSec: s.targetDurationSec,
          pilotDurationSec: s.pilotDurationSec,
          autopilot: s.autopilot,
          consistency: s.consistency,
          approvals: s.approvals,
          generation: s.generation,
          watermark: s.watermark,
          disclosure: s.disclosure,
          dialogue: s.dialogue,
          storyboard: s.storyboard,
        },
      });
      useUi.getState().toast('Settings saved', 'success');
      onClose();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void, name: string) => (
    <label className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-[13px]">
      {label}
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--color-accent)]"
      />
    </label>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Project settings"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save} data-testid="settings-save">
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target length (min)">
            <Input
              type="number"
              min={1}
              max={180}
              value={Math.round(s.targetDurationSec / 60)}
              onChange={(e) => setS({ ...s, targetDurationSec: Math.max(10, Number(e.target.value) * 60) })}
            />
          </Field>
          <Field label="Pilot clip (s)">
            <Input
              type="number"
              min={10}
              max={180}
              value={s.pilotDurationSec}
              onChange={(e) =>
                setS({ ...s, pilotDurationSec: Math.min(180, Math.max(10, Number(e.target.value))) })
              }
            />
          </Field>
          <Field label="Consistency judge">
            <Select
              value={s.consistency.judge}
              onChange={(e) =>
                setS({
                  ...s,
                  consistency: { ...s.consistency, judge: e.target.value as 'vision-llm' | 'off' },
                })
              }
            >
              <option value="vision-llm">Vision LLM</option>
              <option value="off">Off (takes stay unverified)</option>
            </Select>
          </Field>
          <Field label="Threshold">
            <Input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={s.consistency.threshold}
              onChange={(e) =>
                setS({ ...s, consistency: { ...s.consistency, threshold: Number(e.target.value) } })
              }
            />
          </Field>
        </div>
        {toggle(
          'Autopilot: run each stage’s generation automatically',
          s.autopilot,
          (v) => setS({ ...s, autopilot: v }),
          'autopilot',
        )}
        {toggle(
          'Generate audio with video',
          s.generation.includeAudio,
          (v) => setS({ ...s, generation: { ...s.generation, includeAudio: v } }),
          'includeAudio',
        )}
        {toggle(
          'Render consecutive shots in one request when the video model is multi-shot',
          s.generation.multiShot === 'auto',
          (v) => setS({ ...s, generation: { ...s.generation, multiShot: v ? 'auto' : 'off' } }),
          'multiShot',
        )}
        <div className="rounded-[var(--radius-control)] border border-border p-3">
          <p className="mb-2 text-[13px] font-medium">Storyboard</p>
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
            {toggle(
              'Storyboard the first scenes before the pilot',
              s.storyboard.enabled,
              (v) => setS({ ...s, storyboard: { ...s.storyboard, enabled: v } }),
              'storyboardEnabled',
            )}
            <Field label="Scenes to storyboard">
              <Input
                type="number"
                min={1}
                max={50}
                value={s.storyboard.scenes}
                onChange={(e) =>
                  setS({
                    ...s,
                    storyboard: {
                      ...s.storyboard,
                      scenes: Math.min(50, Math.max(1, Number(e.target.value))),
                    },
                  })
                }
                data-testid="storyboard-scenes"
              />
            </Field>
          </div>
        </div>
        <div className="rounded-[var(--radius-control)] border border-border p-3">
          <p className="mb-2 text-[13px] font-medium">Dialogue</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Spoken lines">
              <Select
                value={s.dialogue.mode}
                onChange={(e) =>
                  setS({ ...s, dialogue: { ...s.dialogue, mode: e.target.value as DialogueMode } })
                }
                data-testid="dialogue-mode"
              >
                <option value="tts">Locked voices (TTS) + lip sync</option>
                <option value="native">Model audio, checked against the voices</option>
                <option value="off">Off (captions only)</option>
              </Select>
            </Field>
          </div>
          <div className="mt-2 space-y-1">
            {toggle(
              'Lip-sync pass when the video model cannot take the dialogue',
              s.dialogue.lipSync,
              (v) => setS({ ...s, dialogue: { ...s.dialogue, lipSync: v } }),
              'lipSync',
            )}
            {toggle(
              'Check speakers against their voices (model audio)',
              s.consistency.judgeVoices,
              (v) => setS({ ...s, consistency: { ...s.consistency, judgeVoices: v } }),
              'judgeVoices',
            )}
          </div>
          <p className="mt-2 text-[12px] text-muted">
            Every character who speaks needs a locked voice (Cast). TTS dialogue plays on the timeline’s
            Dialogue track.
          </p>
        </div>
        {toggle(
          'Invisible watermark on generated media',
          s.watermark.enabled,
          (v) => setS({ ...s, watermark: { enabled: v } }),
          'watermark',
        )}
        <div className="rounded-[var(--radius-control)] border border-border p-3">
          <p className="mb-2 text-[13px] font-medium">Disclosure label</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Show">
              <Select
                value={s.disclosure.label}
                onChange={(e) =>
                  setS({
                    ...s,
                    disclosure: {
                      ...s.disclosure,
                      label: e.target.value as ProjectSettings['disclosure']['label'],
                    },
                  })
                }
                data-testid="disclosure-label"
              >
                <option value="auto">When real people appear</option>
                <option value="always">Always</option>
                <option value="off">Never (except real people)</option>
              </Select>
            </Field>
            <Field label="Text">
              <Input
                value={s.disclosure.text}
                maxLength={60}
                onChange={(e) => setS({ ...s, disclosure: { ...s.disclosure, text: e.target.value } })}
                data-testid="disclosure-text"
              />
            </Field>
            <Field label="Corner">
              <Select
                value={s.disclosure.position}
                onChange={(e) =>
                  setS({
                    ...s,
                    disclosure: {
                      ...s.disclosure,
                      position: e.target.value as ProjectSettings['disclosure']['position'],
                    },
                  })
                }
              >
                <option value="top_left">Top left</option>
                <option value="top_right">Top right</option>
                <option value="bottom_left">Bottom left</option>
                <option value="bottom_right">Bottom right</option>
              </Select>
            </Field>
          </div>
          <p className="mt-2 text-[12px] text-muted">
            Exports always carry C2PA Content Credentials. A visible label is added for the whole film; it
            cannot be turned off when a character's likeness is a real person (EU AI Act Article 50).
          </p>
        </div>
        {toggle(
          'Agents may approve gates and clips',
          s.approvals.allowAgents,
          (v) => setS({ ...s, approvals: { ...s.approvals, allowAgents: v } }),
          'allowAgents',
        )}
        {toggle(
          'Agents may override consistency checks',
          s.approvals.allowAgentOverrides,
          (v) => setS({ ...s, approvals: { ...s.approvals, allowAgentOverrides: v } }),
          'allowAgentOverrides',
        )}
      </div>
    </Dialog>
  );
}

export function Overview() {
  const { docs, workflow, jobs, syncIssues, projectId } = useProject();
  const cfg = useConfig();
  const [busy, setBusy] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reopen, setReopen] = useState('');
  if (!docs || !workflow || !projectId) return null;
  const project = docs.project;
  const current = workflow.stages[workflow.stageIndex];
  const gate = current?.gate;
  const active = Object.values(jobs).filter((j) => !isTerminalJob(j) && !j.parentId);
  const approve = async () => {
    if (!gate) return;
    setBusy('approve');
    try {
      await api.approve(projectId, gate.id);
      useUi.getState().toast(`${gate.title}: approved`, 'success');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };
  const mcp = `claude mcp add --transport http rideo ${location.origin}/mcp`;
  const folder = `${cfg?.features.webdavRoot ?? '/rideo'}/projects/${projectId}/`;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <SectionHeader
        title={project.title}
        subtitle={project.kind === 'story' ? project.brief.prompt || 'A generated film' : 'Footage edit'}
        actions={
          <Button
            icon={<Settings2 className="size-4" />}
            onClick={() => setSettingsOpen(true)}
            data-testid="open-settings"
          >
            Settings
          </Button>
        }
      />
      <WorkflowStepper workflow={workflow} />
      {current ? (
        <Card className="p-4" data-testid="current-gate">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-medium tracking-wide text-muted uppercase">Current stage</div>
              <h3 className="text-lg font-semibold">{current.title}</h3>
              <p className="text-[13px] text-muted">{current.description}</p>
            </div>
            {gate && current.id !== 'brief' ? (
              <Button
                variant="primary"
                disabled={!gate.satisfied}
                loading={busy === 'approve'}
                onClick={approve}
                data-testid="approve-gate"
                icon={<Check className="size-4" />}
              >
                {gate.title}
              </Button>
            ) : null}
          </div>
          {gate ? (
            <ul className="mt-3 space-y-1.5">
              {gate.requirements.map((r) => (
                <li
                  key={r.id}
                  className="flex items-start gap-2 text-[13px]"
                  data-requirement={r.id}
                  data-ok={r.ok}
                >
                  {r.ok ? (
                    <Check className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <X className="mt-0.5 size-4 shrink-0 text-warning" />
                  )}
                  <span>
                    {r.ok ? <span className="text-muted">{r.message}</span> : r.message}
                    {!r.ok && r.details?.length ? (
                      <span className="block text-[12px] text-muted">
                        {r.details.slice(0, 5).join(' · ')}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
              {gate.requirements.length === 0 ? (
                <li className="text-[13px] text-muted">Nothing required — continue when ready.</li>
              ) : null}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-muted">
              {workflow.done ? 'Done — an export is ready.' : 'Render an export to finish.'}
            </p>
          )}
          {workflow.stageIndex > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Select
                className="w-auto"
                value={reopen}
                onChange={(e) => setReopen(e.target.value)}
                aria-label="Stage to reopen"
              >
                <option value="">Reopen an earlier stage…</option>
                {workflowFor(project.kind)
                  .stages.slice(0, workflow.stageIndex)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
              </Select>
              <Button
                size="sm"
                icon={<RotateCcw className="size-3.5" />}
                disabled={!reopen}
                onClick={() =>
                  api
                    .reopen(projectId, reopen)
                    .then(() => setReopen(''))
                    .catch(reportError)
                }
              >
                Reopen
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}
      {project.kind === 'story' ? (
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <span className="font-medium">Film length</span>
            <span className="tabular text-muted">
              {formatDuration(workflow.approvedDurationSec)} approved ·{' '}
              {formatDuration(workflow.plannedDurationSec)} planned ·{' '}
              {formatDuration(workflow.targetDurationSec)} target
            </span>
          </div>
          <div className="space-y-1.5">
            <Progress
              value={workflow.plannedDurationSec / Math.max(1, workflow.targetDurationSec)}
              label="planned"
            />
            <Progress
              value={workflow.approvedDurationSec / Math.max(1, workflow.targetDurationSec)}
              tone="success"
              label="approved"
            />
          </div>
        </Card>
      ) : null}
      {active.length ? (
        <div className="space-y-2 xl:hidden">
          <h3 className="text-[11px] font-medium tracking-wide text-muted uppercase">Running</h3>
          {active.map((j) => (
            <JobRow key={j.id} job={j} projectId={projectId} />
          ))}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <Bot className="size-4 text-info" /> Let an agent drive
          </div>
          <p className="text-[13px] text-muted">
            Connect Claude Code (or any MCP client). Its actions appear here live and it can steer this page.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1.5 font-mono text-[12px]"
              data-testid="mcp-command"
            >
              {mcp}
            </code>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Copy command"
              onClick={() =>
                navigator.clipboard?.writeText(mcp).then(() => useUi.getState().toast('Copied', 'success'))
              }
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
        </Card>
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <FolderSync className="size-4 text-muted" /> Assets on WebDAV
          </div>
          <p className="text-[13px] text-muted">
            Mount the share in Finder or Explorer; edits and files dropped into <code>inbox/</code> sync back
            here.
          </p>
          <div className="mt-2 font-mono text-[12px] break-all text-muted" data-testid="webdav-folder">
            {cfg?.features.davUrl ? `${cfg.features.davUrl.replace(/\/$/, '')}${folder}` : folder}
          </div>
          <Button
            size="sm"
            className="mt-3"
            icon={<FolderSync className="size-3.5" />}
            onClick={() =>
              api
                .sync(projectId)
                .then((r) =>
                  useUi
                    .getState()
                    .toast(`Synced: ${r.changed.length} changed, ${r.imported.length} imported`, 'success'),
                )
                .catch(reportError)
            }
          >
            Sync now
          </Button>
          {syncIssues.length ? (
            <ul className="mt-3 space-y-1">
              {syncIssues.map((i) => (
                <li key={i.path} className="flex gap-2 text-[12px] text-warning">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {i.path}: {i.error}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>
      <div className="flex flex-wrap gap-2 text-[12px] text-muted">
        <Badge>{project.settings.aspectRatio}</Badge>
        <Badge>
          {project.settings.resolution.width}×{project.settings.resolution.height} @ {project.settings.fps}{' '}
          fps
        </Badge>
        <Badge>judge: {project.settings.consistency.judge}</Badge>
        <Badge>dialogue: {project.settings.dialogue.mode}</Badge>
        <Badge>threshold {project.settings.consistency.threshold}</Badge>
        {project.settings.autopilot ? <Badge tone="accent">autopilot</Badge> : null}
        <Badge>
          models: {project.settings.models.image} / {project.settings.models.video}
        </Badge>
      </div>
      <SettingsDialog
        key={JSON.stringify(project.settings)}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={project.settings}
        projectId={projectId}
      />
    </div>
  );
}
