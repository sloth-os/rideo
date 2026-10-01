import type { AuditEvent, PublicUser } from '@rideo/shared';
import { ScrollText, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { reportError } from '../../store/ui';
import { AppHeader } from '../workspace/AppHeader';

const TYPES = [
  'auth.login',
  'auth.logout',
  'auth.failed',
  'auth.denied',
  'token.created',
  'token.revoked',
  'user.updated',
  'project.access',
  'project.approval',
];

/** People and the audit log, for administrators (docs/design/accounts.md#audit-log). */
export function AdminPage() {
  const me = useAuth((s) => s.me);
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [type, setType] = useState('');
  const refresh = useCallback(() => {
    api.users().then(setPeople).catch(reportError);
    api
      .audit({ ...(type ? { type } : {}), limit: 200 })
      .then(setEvents)
      .catch(reportError);
  }, [type]);
  useEffect(refresh, [refresh]);
  const update = (id: string, patch: { studioRole?: 'admin' | 'member'; disabled?: boolean }) =>
    api.updateUser(id, patch).then(refresh).catch(reportError);
  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto max-w-5xl space-y-6 px-3 py-6 sm:px-6">
        <section className="space-y-3" data-testid="people">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="size-5" /> People
          </h1>
          <ul className="space-y-2">
            {people.map((u) => (
              <li key={u.id} data-testid="people-row" data-email={u.email}>
                <Card className="flex flex-wrap items-center gap-2 p-3 text-[13px]">
                  <span className="font-medium">{u.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{u.email}</span>
                  {u.disabled ? <Badge tone="danger">disabled</Badge> : null}
                  <Select
                    value={u.studioRole}
                    disabled={u.id === me?.user?.id}
                    onChange={(e) => update(u.id, { studioRole: e.target.value as 'admin' | 'member' })}
                    aria-label={`Studio role of ${u.name}`}
                    data-testid="studio-role"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Administrator</option>
                  </Select>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={u.disabled}
                      disabled={u.id === me?.user?.id}
                      onChange={(e) => update(u.id, { disabled: e.target.checked })}
                      className="size-4 accent-[var(--color-accent)]"
                      data-testid="user-disabled"
                    />
                    Disabled
                  </label>
                </Card>
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-3" data-testid="audit">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <ScrollText className="size-5" /> Audit log
            </h2>
            <Select
              value={type}
              onChange={(e) => setType(e.target.value)}
              aria-label="Event type"
              data-testid="audit-type"
            >
              <option value="">All events</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <ul className="space-y-1.5 text-[12px]">
            {events.map((e, k) => (
              <li
                key={`${e.at}-${k}`}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-border px-2.5 py-1.5"
                data-testid="audit-row"
                data-type={e.type}
              >
                <span className="tabular text-muted">{new Date(e.at).toLocaleString()}</span>
                <Badge tone={e.outcome === 'ok' ? 'neutral' : 'danger'}>{e.type}</Badge>
                <span className="font-medium">{e.actor.name ?? e.actor.id}</span>
                {e.projectId ? <span className="text-muted">{e.projectId}</span> : null}
                <span className="min-w-0 flex-1 truncate text-muted">{JSON.stringify(e.detail)}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
