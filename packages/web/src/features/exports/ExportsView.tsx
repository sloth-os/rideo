import { type Export, formatDuration, isTerminalJob } from '@rideo/shared';
import { Download, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ContentCredentialsPanel } from '../../components/ContentCredentials';
import { Entity } from '../../components/Entity';
import { JobRow } from '../../components/JobProgress';
import { MediaVideo } from '../../components/Media';
import { Badge, Button, EmptyState, SectionHeader } from '../../components/ui';
import { api, mediaUrl, type WatermarkDetection } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError } from '../../store/ui';

function ExportCard({ e, projectId }: { e: Export; projectId: string }) {
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
      {e.media ? (
        <MediaVideo projectId={projectId} media={e.media} className="aspect-video w-full" />
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
          {e.codec ? <Badge>{e.codec}</Badge> : null}
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
