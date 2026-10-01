import type { Project, ProjectRole } from '@rideo/shared';
import { Plus, Trash2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Input, Select } from '../../components/ui';
import { api, type ProjectAccessView } from '../../lib/api';
import { useAuth, useProjectRole } from '../../lib/auth';
import { reportError, useUi } from '../../store/ui';

type Row = { email: string; name?: string; role: ProjectRole; invited?: boolean };
const ROLES: ProjectRole[] = ['director', 'editor', 'reviewer'];

/**
 * Who works on the project (docs/design/accounts.md#users-roles-and-projects): directors add people by email with a
 * role, change roles, remove them and make the project visible to the studio.
 */
export function MembersCard({ project }: { project: Project }) {
  const me = useAuth((s) => s.me);
  const { can } = useProjectRole(project);
  const [view, setView] = useState<ProjectAccessView | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [visibility, setVisibility] = useState<'private' | 'studio'>('private');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectRole>('editor');
  const [busy, setBusy] = useState(false);
  const accessKey = JSON.stringify(project.access);
  useEffect(() => {
    if (me?.mode !== 'oidc') return;
    api
      .projectAccess(project.id)
      .then((v) => {
        setView(v);
        setVisibility(v.visibility);
        setRows([
          ...v.members.map((m) => ({ email: m.email, name: m.name, role: m.role })),
          ...v.invites.map((i) => ({ email: i.email, role: i.role, invited: true })),
        ]);
      })
      .catch(reportError);
  }, [project.id, accessKey, me?.mode]);
  if (me?.mode !== 'oidc' || !view) return null;
  const manage = can('project.manage');
  const save = async (next: Row[], vis = visibility) => {
    setBusy(true);
    try {
      await api.setProjectAccess(project.id, {
        visibility: vis,
        members: next.map((r) => ({ email: r.email, role: r.role })),
      });
      useUi.getState().toast('Members saved', 'success');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4" data-testid="members-card">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <Users className="size-4 text-muted" /> Members
        {view.role ? (
          <Badge tone="accent" testid="my-role">
            you: {view.role}
          </Badge>
        ) : null}
      </div>
      <ul className="space-y-1.5 text-[13px]">
        {rows.map((r, k) => (
          <li
            key={r.email || k}
            className="flex flex-wrap items-center gap-2"
            data-testid="member-row"
            data-email={r.email}
          >
            <span className="min-w-0 flex-1 truncate">
              {r.name ?? r.email}
              {r.invited ? <span className="ml-1 text-muted">(invited)</span> : null}
            </span>
            {manage ? (
              <>
                <Select
                  value={r.role}
                  onChange={(e) =>
                    setRows(rows.map((x, i) => (i === k ? { ...x, role: e.target.value as ProjectRole } : x)))
                  }
                  aria-label={`Role of ${r.name ?? r.email}`}
                  data-testid="member-role"
                >
                  {ROLES.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRows(rows.filter((_, i) => i !== k))}
                  aria-label={`Remove ${r.name ?? r.email}`}
                  data-testid="member-remove"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            ) : (
              <Badge>{r.role}</Badge>
            )}
          </li>
        ))}
      </ul>
      {manage ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@studio.com"
              className="min-w-0 flex-1"
              aria-label="Email of the new member"
              data-testid="add-member-email"
            />
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as ProjectRole)}
              data-testid="add-member-role"
            >
              {ROLES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              icon={<Plus className="size-3.5" />}
              disabled={!/^\S+@\S+$/.test(email)}
              onClick={() => {
                setRows([
                  ...rows.filter((r) => r.email !== email.trim().toLowerCase()),
                  { email: email.trim().toLowerCase(), role, invited: true },
                ]);
                setEmail('');
              }}
              data-testid="add-member"
            >
              Add
            </Button>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={visibility === 'studio'}
              onChange={(e) => setVisibility(e.target.checked ? 'studio' : 'private')}
              className="size-4 accent-[var(--color-accent)]"
              data-testid="visibility-studio"
            />
            Everyone in the studio may review
          </label>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={() => save(rows)}
            data-testid="members-save"
          >
            Save members
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
