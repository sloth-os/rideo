import { PlugZap } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../lib/auth';
import { cx } from './ui';

/**
 * Says that AI features are off because the studio has no mm-gateway (docs/design/settings.md#without-mm-gateway),
 * with a way to Settings for administrators.
 */
export function AiNotice({ children, className }: { children: React.ReactNode; className?: string }) {
  const admin = useAuth((s) => s.me?.admin);
  return (
    <p
      className={cx(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-control)] border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]',
        className,
      )}
      data-testid="ai-off"
    >
      <PlugZap className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
      {admin ? (
        <Link to="/settings#settings-gateway" className="font-medium text-accent hover:underline">
          Connect mm-gateway
        </Link>
      ) : (
        <span className="text-muted">Ask an administrator to connect mm-gateway.</span>
      )}
    </p>
  );
}
