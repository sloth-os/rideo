import { LogIn } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { Card } from '../../components/ui';
import { useAuth } from '../../lib/auth';

/** Sign-in with the studio's identity provider (docs/design/accounts.md#sign-in-oidc). */
export function LoginPage() {
  const [params] = useSearchParams();
  const me = useAuth((s) => s.me);
  const returnTo = params.get('returnTo') ?? '/';
  const error = params.get('error');
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm space-y-4 p-6 text-center" data-testid="login">
        <img src="/logo.svg" alt="" className="mx-auto size-12" />
        <h1 className="text-lg font-semibold">Sign in to Rideo</h1>
        {error ? (
          <p className="text-[13px] break-words text-danger" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
        <a
          href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 font-medium text-accent-contrast"
          data-testid="sign-in"
        >
          <LogIn className="size-4" /> Sign in with {me?.provider ?? 'your identity provider'}
        </a>
      </Card>
    </div>
  );
}
