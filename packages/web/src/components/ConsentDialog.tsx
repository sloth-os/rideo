import { type ConsentInput, missingConsentFields } from '@rideo/shared';
import { UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, cx, Dialog, Field, Input } from './ui';

/**
 * Records consent for an uploaded likeness or voice (docs/design/provenance.md#consent-records): the uploader
 * states whether it shows a real person; a real person needs who is shown, who consented and when.
 */
export function ConsentDialog({
  open,
  what,
  fileName,
  requireRealPerson = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** "reference image", "voice sample", … */
  what: string;
  fileName?: string;
  /** Voice clones always depict a real person. */
  requireRealPerson?: boolean;
  onCancel: () => void;
  onConfirm: (consent: ConsentInput) => void | Promise<void>;
}) {
  const [real, setReal] = useState(requireRealPerson);
  const [subject, setSubject] = useState('');
  const [grantedBy, setGrantedBy] = useState('');
  const [grantedAt, setGrantedAt] = useState(new Date().toISOString().slice(0, 10));
  const [scope, setScope] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setReal(requireRealPerson);
  }, [open, requireRealPerson]);
  const consent: ConsentInput = real
    ? {
        depictsRealPerson: true,
        subject: subject.trim(),
        grantedBy: grantedBy.trim(),
        grantedAt,
        ...(scope.trim() ? { scope: scope.trim() } : {}),
        ...(evidence.trim() ? { evidence: evidence.trim() } : {}),
      }
    : { depictsRealPerson: false };
  const missing = missingConsentFields(consent);
  const choice = (value: boolean, label: string, hint: string, testid: string) => (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-[13px]',
        real === value ? 'border-accent bg-accent/10' : 'border-border bg-surface-2',
        requireRealPerson && !value ? 'cursor-not-allowed opacity-50' : '',
      )}
    >
      <input
        type="radio"
        name="depicts"
        className="mt-0.5 accent-[var(--color-accent)]"
        checked={real === value}
        disabled={requireRealPerson && !value}
        onChange={() => setReal(value)}
        data-testid={testid}
      />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="text-muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={`Consent for this ${what}`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<UserCheck className="size-4" />}
            disabled={missing.length > 0}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(consent);
              } finally {
                setBusy(false);
              }
            }}
            data-testid="consent-submit"
          >
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="consent-dialog">
        {fileName ? <p className="truncate text-[13px] text-muted">{fileName}</p> : null}
        {choice(
          false,
          'A fictional or generated person',
          'Concept art, a generated face, a drawing.',
          'consent-fictional',
        )}
        {choice(
          true,
          'A real person',
          'Exports that show them carry a visible “AI-generated” label (EU AI Act Article 50).',
          'consent-real',
        )}
        {real ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Who is shown">
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                data-testid="consent-subject"
              />
            </Field>
            <Field label="Consent given by" hint="The person, a guardian or the rights holder">
              <Input
                value={grantedBy}
                onChange={(e) => setGrantedBy(e.target.value)}
                data-testid="consent-granted-by"
              />
            </Field>
            <Field label="Date of consent">
              <Input
                type="date"
                value={grantedAt}
                onChange={(e) => setGrantedAt(e.target.value)}
                data-testid="consent-granted-at"
              />
            </Field>
            <Field label="Scope (optional)">
              <Input
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="This production, worldwide, 5 years"
              />
            </Field>
            <Field label="Signed release kept at (optional)" className="sm:col-span-2">
              <Input
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                placeholder="contracts/ada-2026.pdf"
              />
            </Field>
          </div>
        ) : null}
        <p className="text-[12px] text-muted">
          The record is kept in the character's history. It never leaves the studio in Content Credentials.
        </p>
      </div>
    </Dialog>
  );
}
