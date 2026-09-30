import { actorLabel, type CommitSummary, type Diff } from '@rideo/shared';
import { Bot, FolderSync, GitBranch, History, RotateCcw, Tag, User, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Entity } from '../../components/Entity';
import {
  Badge,
  Button,
  Card,
  cx,
  Dialog,
  EmptyState,
  Field,
  Input,
  SectionHeader,
  Select,
  Spinner,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

const ICON = { agent: Bot, user: User, system: Workflow, webdav: FolderSync };

function short(v: unknown): string {
  if (v === undefined) return '∅';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

function DiffPanel({ projectId, commit }: { projectId: string; commit: CommitSummary }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  useEffect(() => {
    setDiff(null);
    api
      .diff(projectId, commit.parents[0] ?? null, commit.id)
      .then(setDiff)
      .catch(reportError);
  }, [projectId, commit.id, commit.parents]);
  if (!diff) return <Spinner />;
  return (
    <div className="space-y-3" data-testid="diff">
      {diff.entries.map((e) => (
        <div key={e.path}>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone={e.op === 'add' ? 'success' : e.op === 'delete' ? 'danger' : 'accent'}>{e.op}</Badge>
            <code className="text-[12px]">{e.path}</code>
            <Button
              size="sm"
              variant="ghost"
              className="h-6"
              icon={<RotateCcw className="size-3" />}
              onClick={() =>
                api
                  .restore(projectId, commit.id, [e.path])
                  .then(() => useUi.getState().toast(`Restored ${e.path}`, 'success'))
                  .catch(reportError)
              }
            >
              Restore file
            </Button>
          </div>
          <ul className="space-y-0.5 font-mono text-[11px]">
            {(e.ops ?? []).slice(0, 40).map((op, i) => (
              <li key={i} className="break-all">
                <span
                  className={
                    op.op === 'add' ? 'text-success' : op.op === 'remove' ? 'text-danger' : 'text-accent'
                  }
                >
                  {op.op}
                </span>{' '}
                {op.pointer}
                {op.op !== 'add' ? <span className="text-muted"> − {short(op.before)}</span> : null}
                {op.op !== 'remove' ? <span> + {short(op.after)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function HistoryView() {
  const { projectId, commits, head } = useProject();
  const [selected, setSelected] = useState<CommitSummary | null>(null);
  const [branches, setBranches] = useState<{ name: string; current: boolean }[]>([]);
  const [branchDialog, setBranchDialog] = useState(false);
  const [tagDialog, setTagDialog] = useState(false);
  const [name, setName] = useState('');
  useEffect(() => {
    if (projectId) api.branches(projectId).then(setBranches).catch(reportError);
  }, [projectId, head?.branch]);
  if (!projectId) return null;
  const tags = new Map<string, string[]>();
  for (const c of commits) if (c.tags?.length) tags.set(c.id, c.tags);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <SectionHeader
        title="History"
        subtitle="Every change by you, agents, jobs and WebDAV edits. Restoring creates a new commit; nothing is rewritten."
        actions={
          <>
            <Select
              value={head?.branch ?? 'main'}
              onChange={(e) => api.switchBranch(projectId, e.target.value).catch(reportError)}
              className="w-auto"
              aria-label="Branch"
              data-testid="branch-select"
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Button icon={<GitBranch className="size-4" />} onClick={() => setBranchDialog(true)}>
              New branch
            </Button>
          </>
        }
      />
      {commits.length === 0 ? (
        <EmptyState icon={<History className="size-8" />} title="No history yet" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ol className="space-y-1.5" data-testid="commits">
            {commits.map((c) => {
              const Icon = ICON[c.author.kind];
              return (
                <Entity key={c.id} kind="commit" id={c.id} as="li">
                  <button
                    type="button"
                    onClick={() => setSelected(c)}
                    className={cx(
                      'w-full rounded-[var(--radius-control)] border px-3 py-2 text-left transition-colors',
                      selected?.id === c.id
                        ? 'border-accent bg-accent/5'
                        : 'border-border bg-surface hover:border-muted',
                    )}
                    data-testid="commit"
                  >
                    <div className="flex items-start gap-2">
                      <Icon
                        className={cx(
                          'mt-0.5 size-4 shrink-0',
                          c.author.kind === 'agent' ? 'text-info' : 'text-muted',
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] break-words">{c.message}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                          <span>{actorLabel(c.author)}</span>
                          <span>·</span>
                          <span>{new Date(c.timestamp).toLocaleString()}</span>
                          <code>{c.id.slice(0, 8)}</code>
                          {Number(c.meta?.coalescedCount ?? 1) > 1 ? (
                            <Badge>×{String(c.meta?.coalescedCount)}</Badge>
                          ) : null}
                          {(tags.get(c.id) ?? []).map((t) => (
                            <Badge key={t} tone="success">
                              <Tag className="size-3" />
                              {t}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>
                  </button>
                </Entity>
              );
            })}
          </ol>
          <Card className="h-fit p-4 lg:sticky lg:top-4">
            {selected ? (
              <div className="space-y-3">
                <div>
                  <div className="font-medium">{selected.message}</div>
                  <div className="text-[12px] text-muted">
                    {actorLabel(selected.author)} · {new Date(selected.timestamp).toLocaleString()} ·{' '}
                    <code>{selected.id.slice(0, 12)}</code>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    icon={<RotateCcw className="size-3.5" />}
                    onClick={() =>
                      confirm('Restore the whole project to this commit? This creates a new commit.') &&
                      api
                        .restore(projectId, selected.id)
                        .then(() => useUi.getState().toast('Project restored', 'success'))
                        .catch(reportError)
                    }
                    data-testid="restore-commit"
                  >
                    Restore project to here
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Tag className="size-3.5" />}
                    onClick={() => setTagDialog(true)}
                  >
                    Tag
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<GitBranch className="size-3.5" />}
                    onClick={() => setBranchDialog(true)}
                  >
                    Branch from here
                  </Button>
                </div>
                <DiffPanel projectId={projectId} commit={selected} />
              </div>
            ) : (
              <p className="text-[13px] text-muted">Select a commit to see what changed.</p>
            )}
          </Card>
        </div>
      )}
      <Dialog
        open={branchDialog}
        onClose={() => setBranchDialog(false)}
        title={selected ? `New branch from ${selected.id.slice(0, 8)}` : 'New branch'}
        footer={
          <Button
            variant="primary"
            disabled={!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)}
            onClick={() =>
              api
                .createBranch(projectId, name, selected?.id)
                .then(() => api.switchBranch(projectId, name))
                .then(() => {
                  setBranchDialog(false);
                  setName('');
                })
                .catch(reportError)
            }
          >
            Create &amp; switch
          </Button>
        }
      >
        <Field label="Name" hint="lowercase letters, digits, dots, dashes">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="alt-ending"
          />
        </Field>
      </Dialog>
      <Dialog
        open={tagDialog}
        onClose={() => setTagDialog(false)}
        title="Tag this commit"
        footer={
          <Button
            variant="primary"
            disabled={!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || !selected}
            onClick={() =>
              selected &&
              api
                .createTag(projectId, name, selected.id)
                .then(() => {
                  setTagDialog(false);
                  setName('');
                  void useProject.getState().refresh();
                })
                .catch(reportError)
            }
          >
            Tag
          </Button>
        }
      >
        <Field label="Tag">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="director-cut"
          />
        </Field>
      </Dialog>
    </div>
  );
}
