import { actorLabel } from '@rideo/shared';
import { Bot, FolderSync, User, Workflow } from 'lucide-react';
import { useProject } from '../store/project';

const ICON = { agent: Bot, user: User, system: Workflow, webdav: FolderSync };

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function ActivityFeed({ limit = 30 }: { limit?: number }) {
  const commits = useProject((s) => s.commits);
  const activity = useProject((s) => s.activity);
  const items = [
    ...activity
      .filter((a) => a.action.startsWith('tool:'))
      .map((a) => ({ key: `a${a.id}`, actor: a.actor, text: a.summary, at: a.at })),
    ...commits.map((c) => ({ key: c.id, actor: c.author, text: c.message, at: c.timestamp })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
  if (!items.length) return <p className="text-[13px] text-muted">No activity yet.</p>;
  return (
    <ul className="space-y-2" data-testid="activity-feed">
      {items.map((i) => {
        const Icon = ICON[i.actor.kind];
        return (
          <li key={i.key} className="flex gap-2 text-[12px]">
            <Icon
              className={
                i.actor.kind === 'agent'
                  ? 'mt-0.5 size-3.5 shrink-0 text-info'
                  : 'mt-0.5 size-3.5 shrink-0 text-muted'
              }
            />
            <div className="min-w-0">
              <div className="break-words">{i.text}</div>
              <div className="text-[11px] text-muted">
                {actorLabel(i.actor)} · {ago(i.at)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
