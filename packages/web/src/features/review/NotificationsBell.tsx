import { Bell, CheckCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { cx } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useNotifications } from '../../store/notifications';

const when = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleDateString();
};

/** Mentions, replies, decisions and gates for the person in this tab (docs/design/review.md#notifications). */
export function NotificationsBell() {
  const me = useAuth((s) => s.me);
  const { items, unread, loaded, load, markRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const signedIn = !!me?.user;
  useEffect(() => {
    if (signedIn && !loaded) void load();
  }, [signedIn, loaded, load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!signedIn) return null;
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        className="relative rounded p-1.5 text-muted hover:text-text"
        onClick={() => setOpen((o) => !o)}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        data-testid="notifications"
      >
        <Bell className="size-4" />
        {unread ? (
          <span
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-contrast"
            data-testid="notifications-unread"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="fixed inset-x-2 top-14 z-40 max-h-[70vh] overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-10 sm:w-80"
          role="menu"
          data-testid="notifications-panel"
        >
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-[13px] font-medium">Notifications</span>
            {unread ? (
              <button
                type="button"
                className="flex items-center gap-1 text-[12px] text-muted hover:text-text"
                onClick={() => void markRead()}
                data-testid="notifications-read-all"
              >
                <CheckCheck className="size-3.5" /> Mark all read
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="px-1 py-3 text-[13px] text-muted">Nothing yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className={cx(
                      'w-full rounded px-2 py-1.5 text-left hover:bg-surface-2',
                      !n.read && 'bg-accent/10',
                    )}
                    onClick={() => {
                      setOpen(false);
                      if (!n.read) void markRead([n.id]);
                      navigate(n.link);
                    }}
                    data-testid="notification-item"
                    data-kind={n.kind}
                    data-read={n.read}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{n.title}</span>
                      <span className="shrink-0 text-[11px] text-muted">{when(n.at)}</span>
                    </div>
                    {n.body ? <p className="line-clamp-2 text-[12px] text-muted">{n.body}</p> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
