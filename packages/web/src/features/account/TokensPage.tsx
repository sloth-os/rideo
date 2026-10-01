import type { ProjectRole, ProjectSummary, TokenInfo } from '@rideo/shared';
import { Copy, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, Field, Input, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { reportError, useUi } from '../../store/ui';
import { AppHeader } from '../workspace/AppHeader';

/** Scoped agent tokens (docs/design/accounts.md#agent-tokens): create, see once, revoke. */
export function TokensPage() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState<ProjectRole>('editor');
  const [projectId, setProjectId] = useState('');
  const [days, setDays] = useState(90);
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = useCallback(() => api.tokens().then(setTokens).catch(reportError), []);
  useEffect(() => {
    void refresh();
    api
      .projects()
      .then(setProjects)
      .catch(() => undefined);
  }, [refresh]);
  const create = async () => {
    try {
      const r = await api.createToken({
        name: name.trim(),
        role,
        ...(projectId ? { projectIds: [projectId] } : {}),
        ...(days ? { expiresInDays: days } : {}),
      });
      setSecret(r.secret);
      setName('');
      await refresh();
    } catch (err) {
      reportError(err);
    }
  };
  const title = (id: string) => projects.find((p) => p.id === id)?.title ?? id;
  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto max-w-3xl space-y-4 px-3 py-6 sm:px-6">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="size-5" /> Agent tokens
        </h1>
        <p className="text-[13px] text-muted">
          An agent (an MCP client, a script) acts on your behalf with a token: at most the token's role, and
          never more than your own role in a project.
        </p>
        <Card className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Claude Code"
                data-testid="token-name"
              />
            </Field>
            <Field label="Role">
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value as ProjectRole)}
                data-testid="token-role"
              >
                <option value="reviewer">Reviewer (read, comment)</option>
                <option value="editor">Editor (edit, generate, export)</option>
                <option value="director">Director (approve, manage)</option>
              </Select>
            </Field>
            <Field label="Projects">
              <Select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                data-testid="token-project"
              >
                <option value="">All my projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Expires">
              <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 30, 90, 365, 0].map((d) => (
                  <option key={d} value={d}>
                    {d ? `in ${d} days` : 'never'}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button variant="primary" disabled={!name.trim()} onClick={create} data-testid="token-create">
            Create token
          </Button>
          {secret ? (
            <div
              className="space-y-1.5 rounded-[var(--radius-control)] border border-warning p-3 text-[13px]"
              data-testid="token-secret"
            >
              <p>Copy it now: it is shown only once.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all" data-testid="token-secret-value">
                  {secret}
                </code>
                <Button
                  size="sm"
                  icon={<Copy className="size-3.5" />}
                  onClick={() => {
                    void navigator.clipboard?.writeText(secret).catch(() => undefined);
                    useUi.getState().toast('Token copied', 'success');
                  }}
                >
                  Copy
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
        {tokens.length === 0 ? (
          <EmptyState icon={<KeyRound className="size-8" />} title="No tokens yet" />
        ) : (
          <ul className="space-y-2">
            {tokens.map((t) => (
              <li key={t.id} data-testid="token-row" data-token={t.id}>
                <Card className="flex flex-wrap items-center gap-2 p-3 text-[13px]">
                  <span className="font-medium">{t.name}</span>
                  <Badge>{t.role}</Badge>
                  <Badge>{t.projectIds ? t.projectIds.map(title).join(', ') : 'all projects'}</Badge>
                  {t.revokedAt ? (
                    <Badge tone="danger">revoked</Badge>
                  ) : t.expiresAt ? (
                    <Badge>expires {new Date(t.expiresAt).toLocaleDateString()}</Badge>
                  ) : null}
                  <span className="flex-1 text-muted">
                    {t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}
                  </span>
                  {!t.revokedAt ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => api.revokeToken(t.id).then(refresh).catch(reportError)}
                      data-testid="token-revoke"
                    >
                      Revoke
                    </Button>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
