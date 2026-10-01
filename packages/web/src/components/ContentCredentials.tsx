import { BadgeCheck, FileWarning, ShieldAlert } from 'lucide-react';
import type { ContentCredentials } from '../lib/api';
import { Badge } from './ui';

const STATE = {
  trusted: { tone: 'success', label: 'trusted signer' },
  valid: { tone: 'info', label: 'intact' },
  invalid: { tone: 'danger', label: 'altered after signing' },
} as const;

/** The C2PA manifest of a file, as read by the server (docs/design/provenance.md#verification). */
export function ContentCredentialsPanel({ cc }: { cc: ContentCredentials | undefined }) {
  if (!cc?.present) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted" data-testid="content-credentials">
        <FileWarning className="size-4" /> No Content Credentials (C2PA) in this file
      </div>
    );
  }
  const state = STATE[cc.state ?? 'valid'];
  return (
    <div className="space-y-2" data-testid="content-credentials" data-state={cc.state}>
      <div className="flex flex-wrap items-center gap-2 font-medium">
        {cc.state === 'invalid' ? (
          <ShieldAlert className="size-5 text-danger" />
        ) : (
          <BadgeCheck className="size-5 text-success" />
        )}
        Content Credentials
        <Badge tone={state.tone}>{state.label}</Badge>
        {cc.aiGenerated ? <Badge tone="accent">AI-generated</Badge> : <Badge>composite</Badge>}
        {cc.bound ? <Badge tone="success">bound to the watermark</Badge> : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-muted">Signed by</dt>
        <dd>
          {cc.signer?.commonName ?? '—'}
          {cc.signer?.issuer ? <span className="text-muted"> ({cc.signer.issuer})</span> : null}
          {cc.signedByThisStudio ? <span className="text-muted"> · this studio</span> : null}
        </dd>
        <dt className="text-muted">Made with</dt>
        <dd>{cc.claimGenerator ?? '—'}</dd>
        <dt className="text-muted">Actions</dt>
        <dd>{cc.actions?.map((a) => a.replace(/^c2pa\./, '')).join(' → ') || '—'}</dd>
        <dt className="text-muted">Ingredients</dt>
        <dd>{cc.ingredients ?? 0}</dd>
        {cc.disclosure ? (
          <>
            <dt className="text-muted">Visible label</dt>
            <dd>
              {cc.disclosure.label
                ? `“${cc.disclosure.text ?? ''}”${cc.disclosure.reason === 'real_person' ? ' (shows a real person)' : ''}`
                : 'none'}
            </dd>
          </>
        ) : null}
        {cc.issues?.length ? (
          <>
            <dt className="text-muted">Issues</dt>
            <dd className="break-words text-danger">{cc.issues.join(', ')}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
