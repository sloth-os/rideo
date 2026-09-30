import { Bot, CheckCircle2, Info, TriangleAlert, XCircle } from 'lucide-react';
import { useUi } from '../store/ui';
import { cx } from './ui';

const ICONS = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: XCircle };
const TONE = {
  info: 'border-info/40',
  success: 'border-success/40',
  warning: 'border-warning/40',
  error: 'border-danger/50',
};

export function Toaster() {
  const { toasts, dismiss } = useUi();
  return (
    <div
      className="pointer-events-none fixed inset-x-3 top-3 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:top-auto sm:right-4 sm:bottom-4 sm:items-end"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon = t.actor?.kind === 'agent' ? Bot : ICONS[t.level];
        return (
          <div
            key={t.id}
            role="status"
            data-testid="toast"
            className={cx(
              'pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-[var(--radius-card)] border bg-surface px-3 py-2.5 shadow-xl',
              TONE[t.level],
            )}
            onClick={() => dismiss(t.id)}
          >
            <Icon
              className={cx(
                'mt-0.5 size-4 shrink-0',
                t.actor?.kind === 'agent'
                  ? 'text-info'
                  : t.level === 'error'
                    ? 'text-danger'
                    : t.level === 'success'
                      ? 'text-success'
                      : t.level === 'warning'
                        ? 'text-warning'
                        : 'text-info',
              )}
            />
            <div className="min-w-0 text-[13px]">
              {t.actor ? <div className="text-[11px] text-muted">{t.actor.name ?? t.actor.id}</div> : null}
              <div className="break-words">{t.message}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
