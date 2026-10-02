import { Cpu, KeyRound, Loader2, LogOut, Moon, Palette, ShieldCheck, Sun, Users } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { cx } from '../../components/ui';
import { useEngine } from '../../engine/state';
import { useAuth } from '../../lib/auth';
import { useUi } from '../../store/ui';
import { NotificationsBell } from '../review/NotificationsBell';

export function LiveDot() {
  const live = useUi((s) => s.live);
  return (
    <span
      className="flex items-center gap-1.5 text-[12px] text-muted"
      data-testid="live-status"
      data-status={live}
    >
      <span
        className={cx(
          'size-2 rounded-full',
          live === 'live' ? 'bg-success' : live === 'connecting' ? 'bg-warning' : 'bg-danger',
        )}
      />
      <span className="hidden sm:inline">
        {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting' : 'Offline'}
      </span>
    </span>
  );
}

const BUSY: Record<string, string> = {
  'media.process': 'preparing media',
  'analysis.signals': 'analyzing footage',
  'export.render': 'rendering',
};

/** The tab's editor engine: ffmpeg.wasm state and the editor job it is running. */
export function EngineStatus() {
  const { ffmpeg, busy, threads, compositor } = useEngine();
  const pct =
    busy && busy.progress.total > 0 ? Math.round((100 * busy.progress.done) / busy.progress.total) : null;
  const state = busy ? 'busy' : ffmpeg;
  const label = busy
    ? `${BUSY[busy.kind] ?? busy.kind}${pct !== null ? ` ${pct}%` : ''}`
    : ffmpeg === 'ready'
      ? 'engine ready'
      : ffmpeg === 'loading'
        ? 'loading engine'
        : ffmpeg === 'failed'
          ? 'engine failed'
          : 'engine idle';
  return (
    <span
      className={cx(
        'flex items-center gap-1.5 text-[12px]',
        busy ? 'text-accent' : ffmpeg === 'failed' ? 'text-danger' : 'text-muted',
      )}
      data-testid="engine-status"
      data-state={state}
      data-threads={threads}
      data-ticks={busy?.ticks}
      data-compositor={compositor ?? undefined}
      title={`Editor engine of this tab: ffmpeg.wasm (${threads > 1 ? `${threads} threads` : 'single-threaded'}), WebCodecs${compositor ? `, ${compositor === 'webgpu' ? 'WebGPU' : 'canvas'} compositing` : ''}`}
    >
      {busy || ffmpeg === 'loading' ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Cpu className="size-3.5" />
      )}
      <span className="hidden md:inline">{label}</span>
    </span>
  );
}

/** The signed-in person: their tokens, the admin pages, sign-out (docs/design/accounts.md#surfaces). */
export function UserMenu() {
  const me = useAuth((s) => s.me);
  const signOut = useAuth((s) => s.signOut);
  const [open, setOpen] = useState(false);
  if (me?.mode !== 'oidc' || !me.user) return null;
  const initials = me.user.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="relative">
      <button
        type="button"
        className="flex size-8 items-center justify-center rounded-full bg-accent text-[12px] font-semibold text-accent-contrast"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Account of ${me.user.name}`}
        aria-expanded={open}
        data-testid="user-menu"
      >
        {initials}
      </button>
      {open ? (
        <div
          className="absolute right-0 top-10 z-40 w-56 space-y-1 rounded-[var(--radius-card)] border border-border bg-surface p-2 text-[13px] shadow-lg"
          role="menu"
        >
          <div className="px-2 py-1">
            <div className="font-medium" data-testid="user-name">
              {me.user.name}
            </div>
            <div className="truncate text-[12px] text-muted">{me.user.email}</div>
          </div>
          <Link
            to="/tokens"
            className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2"
            role="menuitem"
            data-testid="user-menu-tokens"
          >
            <KeyRound className="size-3.5" /> Agent tokens
          </Link>
          {me.admin ? (
            <Link
              to="/admin"
              className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2"
              role="menuitem"
              data-testid="user-menu-admin"
            >
              <Users className="size-3.5" /> People and audit log
            </Link>
          ) : null}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2"
            onClick={() => void signOut()}
            role="menuitem"
            data-testid="sign-out"
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AppHeader({ children }: { children?: ReactNode }) {
  const { theme, setTheme } = useUi();
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-bg/95 px-3 backdrop-blur sm:px-4">
      <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
        <img src="/logo.svg" alt="" className="size-7" />
        <span className="hidden sm:inline">Rideo</span>
      </Link>
      <div className="min-w-0 flex-1">{children}</div>
      <EngineStatus />
      <LiveDot />
      <Link
        to="/brand"
        className="rounded p-1.5 text-muted hover:text-text"
        aria-label="Brand kits"
        title="Brand kits"
        data-testid="brand-kits-link"
      >
        <Palette className="size-4" />
      </Link>
      <Link
        to="/verify"
        className="rounded p-1.5 text-muted hover:text-text"
        aria-label="Verify watermark"
        title="Verify watermark"
      >
        <ShieldCheck className="size-4" />
      </Link>
      <button
        type="button"
        className="rounded p-1.5 text-muted hover:text-text"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        aria-label="Toggle theme"
      >
        {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
      <NotificationsBell />
      <UserMenu />
    </header>
  );
}
