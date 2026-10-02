import { type Export, formatDuration, isTerminalJob, languageName } from '@rideo/shared';
import { Download, MessageSquare, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ContentCredentialsPanel } from '../../components/ContentCredentials';
import { Entity } from '../../components/Entity';
import { JobRow } from '../../components/JobProgress';
import { MediaVideo } from '../../components/Media';
import { Badge, Button, EmptyState, SectionHeader } from '../../components/ui';
import { api, mediaUrl, type WatermarkDetection } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError } from '../../store/ui';
import { openThreads, useReviewDialog } from '../review/ReviewHost';

function ExportCard({ e, projectId }: { e: Export; projectId: string }) {
  const review = useReviewDialog();
  const openCount = useProject((s) =>
    s.docs ? openThreads(s.docs.comments, { kind: 'export', exportId: e.id }) : 0,
  );
  const [check, setCheck] = useState<WatermarkDetection | null>(null);
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    if (!e.media) return;
    setBusy(true);
    try {
      setCheck(await api.detectMedia(projectId, e.media.path));
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Entity
      kind="export"
      id={e.id}
      as="article"
      className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
    >
      {e.media && e.media.mime === 'video/mp4' ? (
        <MediaVideo projectId={projectId} media={e.media} className="aspect-video w-full" />
      ) : e.media ? (
        // Masters (ProRes, image sequences) are for other tools; the browser shows what they are.
        <div className="flex aspect-video flex-col items-center justify-center gap-1 bg-surface-2 text-[13px] text-muted">
          <span className="font-medium text-text">
            {e.delivery?.format === 'frames' ? 'Image-sequence master' : 'ProRes master'}
          </span>
          <span>{e.media.mime}</span>
        </div>
      ) : (
        <div className="flex aspect-video items-center justify-center bg-surface-2 text-[13px] text-muted">
          {e.status}…
        </div>
      )}
      <div className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={e.status === 'succeeded' ? 'success' : e.status === 'failed' ? 'danger' : 'warning'}>
            {e.status}
          </Badge>
          <Badge>{e.method}</Badge>
          {e.engine ? <Badge tone="info">{e.engine}</Badge> : null}
          <Badge>{e.quality}</Badge>
          {e.source === 'animatic' ? (
            <Badge tone="info" testid="export-animatic-badge">
              animatic
            </Badge>
          ) : null}
          {e.codec ? <Badge>{e.codec}</Badge> : null}
          {e.delivery ? (
            <Badge testid="export-delivery">
              {e.delivery.preset} ·{' '}
              {e.delivery.format === 'frames' ? 'png+wav' : e.delivery.format === 'prores' ? 'prores' : 'mp4'}
              {' · '}
              {e.delivery.width}×{e.delivery.height} · {e.delivery.fps} fps
              {e.delivery.aspect !== 'source' ? ` · ${e.delivery.aspect}` : ''}
            </Badge>
          ) : null}
          {e.delivery?.enhance && (e.delivery.enhance.upscale || e.delivery.enhance.interpolate) ? (
            <Badge
              tone="info"
              title={
                e.delivery.enhance.model
                  ? `Enhanced by ${e.delivery.enhance.model}`
                  : 'Enhanced with ffmpeg (no enhancement model)'
              }
              testid="export-enhance"
            >
              {[
                e.delivery.enhance.upscale ? 'upscaled' : null,
                e.delivery.enhance.interpolate ? 'interpolated' : null,
              ]
                .filter(Boolean)
                .join(' + ')}
              {' · '}
              {e.delivery.enhance.model ?? 'ffmpeg'}
            </Badge>
          ) : null}
          {e.language ? (
            <Badge tone="accent" testid="export-language-badge">
              {languageName(e.language)}
              {e.dubbed ? ' · dubbed' : ''}
            </Badge>
          ) : null}
          {e.captions === 'sidecar' ? <Badge>captions: files</Badge> : null}
          {e.loudness && e.loudness.integratedLufs !== null ? (
            <Badge
              tone="info"
              title={`${e.loudness.target} target · ${e.loudness.mode} normalization · true peak ${e.loudness.truePeakDb} dBTP · from ${e.loudness.inputLufs} LUFS`}
              testid="export-loudness-badge"
            >
              {e.loudness.integratedLufs.toFixed(1)} LUFS
            </Badge>
          ) : null}
          {e.durationSec ? <Badge>{formatDuration(e.durationSec)}</Badge> : null}
          {e.contentCredentials ? (
            <Badge tone="success" title={`C2PA manifest ${e.contentCredentials.manifest}`}>
              Content Credentials
            </Badge>
          ) : null}
          {e.disclosure?.label ? (
            <Badge
              tone="info"
              title={e.disclosure.reason === 'real_person' ? 'Shows a real person' : 'Project policy'}
            >
              label “{e.disclosure.text}”
            </Badge>
          ) : null}
        </div>
        <div className="text-[11px] text-muted">{new Date(e.createdAt).toLocaleString()}</div>
        {e.error ? <p className="text-[12px] break-words text-danger">{e.error}</p> : null}
        {e.watermarkId ? (
          <div className="flex items-center gap-1.5 text-[12px]">
            <ShieldCheck className="size-3.5 text-success" /> Watermark <code>{e.watermarkId}</code>
          </div>
        ) : null}
        {e.media ? (
          <div className="flex flex-wrap gap-2">
            <a
              href={mediaUrl(projectId, e.media.path)}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-2.5 text-[13px] font-medium text-accent-contrast"
              data-testid="download-export"
            >
              <Download className="size-3.5" /> Download
            </a>
            <Button
              size="sm"
              loading={busy}
              icon={<ShieldCheck className="size-3.5" />}
              onClick={verify}
              data-testid="verify-export"
            >
              Verify
            </Button>
            {e.media.mime === 'video/mp4' ? (
              <Button
                size="sm"
                icon={<MessageSquare className="size-3.5" />}
                onClick={() => review?.open({ kind: 'export', exportId: e.id })}
                data-testid="review-export"
                data-open={openCount}
              >
                Comments{openCount ? ` · ${openCount}` : ''}
              </Button>
            ) : null}
          </div>
        ) : null}
        {e.thumbnails.length ? (
          <div className="grid grid-cols-3 gap-1.5" data-testid="export-thumbnails">
            {e.thumbnails.map((t, k) => (
              <a key={t.path} href={mediaUrl(projectId, t.path)} download data-testid="download-thumbnail">
                <img
                  src={mediaUrl(projectId, t.path)}
                  alt={`Thumbnail ${k + 1}`}
                  className="aspect-video w-full rounded object-cover"
                />
              </a>
            ))}
          </div>
        ) : null}
        {e.subtitles ? (
          <div className="flex flex-wrap items-center gap-2 text-[12px]" data-testid="export-subtitles">
            <span className="text-muted">Subtitles</span>
            {(['srt', 'vtt'] as const).map((f) => (
              <a
                key={f}
                href={mediaUrl(projectId, e.subtitles![f].path)}
                download
                className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] border border-border px-2"
                data-testid={`download-export-${f}`}
              >
                <Download className="size-3" /> {f.toUpperCase()}
              </a>
            ))}
          </div>
        ) : null}
        {e.stems ? (
          <div className="flex flex-wrap items-center gap-2 text-[12px]" data-testid="export-stems-links">
            <span className="text-muted">Stems</span>
            {(['dialogue', 'music', 'effects'] as const).map((role) => (
              <a
                key={role}
                href={mediaUrl(projectId, e.stems![role].path)}
                download
                className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] border border-border px-2"
                data-testid={`download-stem-${role}`}
              >
                <Download className="size-3" /> {role}
              </a>
            ))}
          </div>
        ) : null}
        {check ? (
          <div className="space-y-2">
            <p
              className={check.found ? 'text-[12px] text-success' : 'text-[12px] text-warning'}
              data-testid="verify-result"
            >
              {check.found
                ? `Watermark ${check.id} found (confidence ${Math.round(check.confidence * 100)}%) — ${check.provenance?.brand.name ?? ''} ${check.provenance?.asset.kind ?? ''}`
                : 'No watermark detected'}
            </p>
            <ContentCredentialsPanel cc={check.contentCredentials} />
          </div>
        ) : null}
      </div>
    </Entity>
  );
}

export function ExportsView() {
  const { docs, projectId, jobs } = useProject();
  if (!docs || !projectId) return null;
  const exports = Object.values(docs.exports).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const running = Object.values(jobs).filter(
    (j) => (j.kind === 'export.render' || j.kind === 'export.finish') && !isTerminalJob(j),
  );
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SectionHeader
        title="Exports"
        subtitle="Every export carries C2PA Content Credentials, an invisible keyed watermark and provenance metadata."
      />
      {running.map((j) => (
        <JobRow key={j.id} job={j} projectId={projectId} />
      ))}
      {exports.length === 0 ? (
        <EmptyState icon={<Download className="size-8" />} title="No exports yet">
          Render from the editor.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="exports">
          {exports.map((e) => (
            <ExportCard key={e.id} e={e} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}
