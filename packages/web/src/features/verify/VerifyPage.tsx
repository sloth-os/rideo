import { ShieldCheck, ShieldX, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { ContentCredentialsPanel } from '../../components/ContentCredentials';
import { Button, Card } from '../../components/ui';
import { api, type WatermarkDetection } from '../../lib/api';
import { reportError } from '../../store/ui';
import { AppHeader } from '../workspace/AppHeader';

export function VerifyPage() {
  const [result, setResult] = useState<WatermarkDetection | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const check = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setName(file.name);
    try {
      setResult(await api.detectWatermark(file));
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto max-w-2xl space-y-4 px-3 py-8 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Verify a video</h1>
        <p className="text-[13px] text-muted">
          Rideo signs every generated clip and export with C2PA Content Credentials and embeds an invisible,
          keyed watermark. Drop a video to read its credentials and recover its brand and provenance — the
          watermark survives re-encoding, trimming and metadata stripping. Free to use, no account needed.
        </p>
        <Card className="p-6 text-center">
          <Upload className="mx-auto mb-2 size-6 text-muted" />
          <Button
            variant="primary"
            loading={busy}
            onClick={() => ref.current?.click()}
            data-testid="verify-choose"
          >
            Choose a video
          </Button>
          <input
            ref={ref}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => check(e.target.files?.[0])}
            data-testid="verify-input"
          />
          {name ? <div className="mt-2 text-[12px] text-muted">{name}</div> : null}
        </Card>
        {result ? (
          <Card className="p-4" data-testid="verify-page-result">
            {result.found ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 font-medium text-success">
                  <ShieldCheck className="size-5" /> Watermark found: <code>{result.id}</code>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                  <dt className="text-muted">Brand</dt>
                  <dd>{result.provenance?.brand.name ?? '—'}</dd>
                  <dt className="text-muted">Owner</dt>
                  <dd>{result.provenance?.brand.owner || '—'}</dd>
                  {result.provenance?.projectId ? (
                    <>
                      <dt className="text-muted">Project</dt>
                      <dd>
                        <code>{result.provenance.projectId}</code>
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-muted">Asset</dt>
                  <dd>
                    {result.provenance
                      ? `${result.provenance.asset.kind}${result.provenance.asset.id ? ` ${result.provenance.asset.id}` : ''}`
                      : 'not in this registry'}
                  </dd>
                  <dt className="text-muted">Created</dt>
                  <dd>{result.provenance ? new Date(result.provenance.createdAt).toLocaleString() : '—'}</dd>
                  <dt className="text-muted">Confidence</dt>
                  <dd>
                    {Math.round(result.confidence * 100)}% ({result.framesAnalyzed} frames
                    {result.corrected ? `, ${result.corrected} bit(s) corrected` : ''})
                  </dd>
                </dl>
              </div>
            ) : (
              <div className="flex items-center gap-2 font-medium text-warning">
                <ShieldX className="size-5" /> No Rideo watermark detected
              </div>
            )}
            <div className="mt-4 border-t border-border pt-3">
              <ContentCredentialsPanel cc={result.contentCredentials} />
            </div>
            {result.metadata.copyright || result.metadata.comment ? (
              <p className="mt-3 text-[12px] text-muted">
                Container metadata: {result.metadata.copyright} {result.metadata.comment}
              </p>
            ) : null}
          </Card>
        ) : null}
      </main>
    </div>
  );
}
