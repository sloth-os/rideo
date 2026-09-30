import { Cpu, Loader2, Moon, ShieldCheck, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../../components/ui';
import { useEngine } from '../../engine/state';
import { useUi } from '../../store/ui';

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
  const { ffmpeg, busy } = useEngine();
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
      title="Editor engine (ffmpeg.wasm + WebCodecs) of this tab"
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
    </header>
  );
}
