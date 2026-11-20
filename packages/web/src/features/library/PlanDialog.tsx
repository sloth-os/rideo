import type { LibraryApplyPlan } from '@rideo/shared';
import { UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, cx, Dialog, Spinner } from '../../components/ui';
import { useUi } from '../../store/ui';
import { libraryApi } from './api';
import { type PlanRequest, useLibraryScope } from './context';
import { appliedText, libraryErrorText, type PlanTone, planAllowed, planLines, planTitle } from './words';

const TONE: Record<PlanTone, string> = {
  muted: 'text-muted',
  info: 'text-info',
  warning: 'border-warning/40 bg-warning/10 text-text',
  danger: 'border-danger/40 bg-danger/10 text-text',
};

/**
 * Update… and Link (docs/design/library.md#use-in-project-update-and-link-apply): the apply's dry run first, its plan
 * in words (what changes, the lock versions, the takes that go stale, the approved clips that need a director, the
 * edits made here that are replaced, the consent for a real person), then the apply itself.
 */
export function PlanDialog({ request, onClose }: { request: PlanRequest; onClose: () => void }) {
  const scope = useLibraryScope();
  const [plan, setPlan] = useState<LibraryApplyPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const projectId = scope?.projectId;
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    setPlan(null);
    setError(null);
    libraryApi
      .apply(projectId, {
        itemId: request.itemId,
        ...(request.version ? { version: request.version } : {}),
        target: { kind: request.target.kind, id: request.target.id },
        dryRun: true,
      })
      .then(
        (out) => live && setPlan(out.plan),
        (err) => live && setError(libraryErrorText(err)),
      );
    return () => {
      live = false;
    };
  }, [projectId, request]);
  if (!scope) return null;
  const allowed = plan ? planAllowed(plan, scope.canApprove) : false;
  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const out = await libraryApi.apply(scope.projectId, {
        itemId: request.itemId,
        version: plan.item.version,
        target: { kind: request.target.kind, id: request.target.id },
        ...(plan.realPerson ? { acknowledgeConsent: consent } : {}),
      });
      useUi.getState().toast(appliedText(out, request.fromVersion), 'success');
      scope.refresh();
      onClose();
    } catch (err) {
      setError(libraryErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  const verb = plan?.mode === 'link' ? 'Link' : 'Update';
  return (
    <Dialog
      open
      onClose={onClose}
      title={plan ? planTitle(plan, request.fromVersion) : `${request.target.name} from the library`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!plan || !scope.canEdit || !allowed || (plan.realPerson && !consent)}
            title={
              !scope.canEdit
                ? 'Editors and directors change the project'
                : plan && !allowed
                  ? 'Approved clips are affected: a director updates'
                  : undefined
            }
            onClick={confirm}
            data-testid="plan-confirm"
          >
            {verb}
          </Button>
        </>
      }
    >
      <div className="space-y-2" data-testid="library-plan">
        {!plan && !error ? (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Spinner /> Working out what changes…
          </p>
        ) : null}
        {plan
          ? planLines(plan, { fromVersion: request.fromVersion, canApprove: scope.canApprove }).map((l) => (
              <p
                key={l.id}
                className={cx(
                  'text-[13px]',
                  l.tone === 'warning' || l.tone === 'danger'
                    ? 'rounded-[var(--radius-control)] border px-3 py-2'
                    : '',
                  TONE[l.tone],
                )}
                data-testid={`plan-${l.id}`}
              >
                {l.text}
              </p>
            ))
          : null}
        {plan?.realPerson ? (
          <label
            className="flex items-start gap-2 rounded-[var(--radius-control)] border border-info/40 bg-info/10 px-3 py-2 text-[13px]"
            data-testid="plan-consent"
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--color-accent)]"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              data-testid="plan-consent-check"
            />
            <span>
              <span className="flex items-center gap-1 font-medium">
                <UserCheck className="size-3.5" /> A real person
              </span>
              The consent covers using this likeness and voice in this project.
            </span>
          </label>
        ) : null}
        {error ? (
          <p className="text-[13px] text-danger" role="alert" data-testid="plan-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
