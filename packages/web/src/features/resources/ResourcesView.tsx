import { formatDuration, isTerminalJob, type Resource, type ResourceRole } from '@rideo/shared';
import { Music, ScanSearch, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Entity } from '../../components/Entity';
import { JobRow } from '../../components/JobProgress';
import { MediaImage, MediaVideo } from '../../components/Media';
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  Input,
  SectionHeader,
  Select,
} from '../../components/ui';
import { rememberUpload } from '../../engine/media-files';
import { prepareMedia } from '../../engine/prepare';
import { api, mediaUrl } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

function ResourceCard({ r, projectId }: { r: Resource; projectId: string }) {
  return (
    <Entity
      kind="resource"
      id={r.id}
      as="article"
      className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
    >
      {r.kind === 'image' ? (
        <MediaImage projectId={projectId} media={r.media} alt={r.name} className="aspect-video w-full" />
      ) : r.kind === 'video' ? (
        <MediaVideo projectId={projectId} media={r.media} className="aspect-video w-full" />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center bg-surface-2 p-3">
          {/* biome-ignore lint/a11y/useMediaCaption: user-provided audio */}
          <audio controls src={mediaUrl(projectId, r.media.path)} className="w-full" preload="none" />
        </div>
      )}
      <div className="flex items-center gap-2 p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium" title={r.name}>
            {r.name}
          </div>
          <div className="text-[11px] text-muted">
            {r.kind} · {r.role}
            {r.media.durationSec ? ` · ${formatDuration(r.media.durationSec)}` : ''}
            {r.media.width ? ` · ${r.media.width}×${r.media.height}` : ''}
          </div>
        </div>
        <Badge
          tone={r.status === 'ready' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}
          title={r.error}
        >
          {r.status}
        </Badge>
      </div>
    </Entity>
  );
}

export function ResourcesView() {
  const { docs, projectId, jobs, workflow } = useProject();
  const fileRef = useRef<HTMLInputElement>(null);
  const [role, setRole] = useState<ResourceRole | ''>('');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [uploadStep, setUploadStep] = useState<string | null>(null);
  const [music, setMusic] = useState({ prompt: '', durationSec: 60 });
  const navigate = useNavigate();
  if (!docs || !projectId) return null;
  const isEdit = docs.project.kind === 'edit';
  const resources = Object.values(docs.resources).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const musicJob = Object.values(jobs).find((j) => j.kind === 'music.generate' && !isTerminalJob(j));
  const upload = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    setUploading((n) => n + files.length);
    for (const f of Array.from(files)) {
      try {
        // Probe and poster in this browser (docs/design/editor.md#media-preparation-uploads); if the engine
        // cannot load, the plain upload becomes a media.process editor job.
        setUploadStep(`Preparing ${f.name} with ffmpeg.wasm…`);
        const prepared = await prepareMedia(f, { poster: f.type.startsWith('video/') }).catch(() => ({
          probe: null,
          poster: null,
        }));
        setUploadStep(`Uploading ${f.name}…`);
        const resource = await api.upload(projectId, f, {
          ...(role ? { role } : {}),
          probe: prepared.probe,
          poster: prepared.poster,
        });
        rememberUpload(resource.media, f);
      } catch (err) {
        reportError(err);
      } finally {
        setUploading((n) => n - 1);
        setUploadStep(null);
      }
    }
  };
  const gate = workflow?.stages.find((s) => s.id === (isEdit ? 'ingest' : 'resources'))?.gate;
  const atStage = workflow?.stage === (isEdit ? 'ingest' : 'resources');
  // Footage: approving the ingest gate also starts the analysis of the source video.
  const proceed = async () => {
    if (!gate) return;
    try {
      await api.approve(projectId, gate.id);
      if (isEdit) {
        const videos = resources.filter((r) => r.kind === 'video' && r.status === 'ready');
        const source = videos.find((v) => v.role === 'source') ?? videos[0];
        if (source) await api.analyze(projectId, source.id);
        navigate(`/p/${projectId}/analysis`);
      } else {
        useUi.getState().toast(`${gate.title}: done`, 'success');
        navigate(`/p/${projectId}/clips`);
      }
    } catch (err) {
      reportError(err);
    }
  };
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SectionHeader
        title={isEdit ? 'Footage' : 'Resources'}
        subtitle={
          isEdit
            ? 'Upload the video to edit. Rideo builds a browser-safe proxy for editing.'
            : 'Add voice-over, music, sound effects, images or footage; generate music.'
        }
        actions={
          atStage && gate ? (
            <Button
              variant="primary"
              icon={isEdit ? <ScanSearch className="size-4" /> : undefined}
              disabled={!gate.satisfied}
              onClick={proceed}
              data-testid="approve-resources"
            >
              {isEdit ? 'Analyze footage' : 'Continue to pilot'}
            </Button>
          ) : null
        }
      />
      <Card
        className={cx(
          'border-dashed p-6 text-center transition-colors',
          dragging && 'border-accent bg-accent/5',
        )}
        onDragOver={(e: React.DragEvent) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e: React.DragEvent) => {
          e.preventDefault();
          setDragging(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
      >
        <Upload className="mx-auto mb-2 size-6 text-muted" />
        <p className="text-[13px] text-muted">Drop files here, or</p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as ResourceRole | '')}
            className="w-auto"
            aria-label="Role"
          >
            <option value="">Role: automatic</option>
            {(['source', 'reference', 'music', 'voiceover', 'sfx', 'other'] as const).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            icon={<Upload className="size-4" />}
            loading={uploading > 0}
            onClick={() => fileRef.current?.click()}
          >
            Choose files
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="video/*,image/*,audio/*"
            hidden
            onChange={(e) => upload(e.target.files)}
            data-testid="resource-upload"
          />
        </div>
        {uploadStep ? (
          <p className="mt-2 text-[12px] text-muted" data-testid="upload-status">
            {uploadStep}
          </p>
        ) : null}
      </Card>
      {!isEdit ? (
        <Card className="p-4">
          <h3 className="mb-3 flex items-center gap-2 font-medium">
            <Music className="size-4 text-muted" /> Generate music
          </h3>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Prompt" className="flex-1">
              <Input
                value={music.prompt}
                onChange={(e) => setMusic({ ...music, prompt: e.target.value })}
                placeholder="Slow brooding strings with a hopeful piano theme"
              />
            </Field>
            <Field label="Seconds" className="sm:w-28">
              <Input
                type="number"
                min={5}
                max={600}
                value={music.durationSec}
                onChange={(e) => setMusic({ ...music, durationSec: Number(e.target.value) })}
              />
            </Field>
            <Button
              loading={!!musicJob}
              disabled={music.prompt.trim().length < 3}
              onClick={() =>
                api
                  .generateMusic(projectId, { prompt: music.prompt, durationSec: music.durationSec })
                  .catch(reportError)
              }
            >
              Compose
            </Button>
          </div>
          {musicJob ? (
            <div className="mt-3">
              <JobRow job={musicJob} projectId={projectId} />
            </div>
          ) : null}
        </Card>
      ) : null}
      {resources.length === 0 ? (
        <EmptyState title="Nothing here yet">
          Uploads, music and files dropped into the WebDAV inbox appear here.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="resources">
          {resources.map((r) => (
            <ResourceCard key={r.id} r={r} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}
