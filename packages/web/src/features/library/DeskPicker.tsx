import { formatBytes, type LibraryItemSummary } from '@rideo/shared';
import { useState } from 'react';
import { Badge, Button, Dialog, EmptyState, Spinner } from '../../components/ui';
import { useUi } from '../../store/ui';
import { libraryApi } from './api';
import { type DeskRequest, useLibraryScope } from './context';
import { LibraryFilters, LibraryThumb, useDebounced, useLibraryList } from './parts';
import { appliedText, DESK_LABEL, libraryErrorText } from './words';

/** What a 3D unit is, in a line: a figure's kind and height, a set's size, the file's size. */
export function unitLine(item: Pick<LibraryItemSummary, 'unit'>): string {
  const u = item.unit;
  if (!u) return '';
  const parts: string[] = [];
  if (u.actorKind) parts.push(`${u.actorKind}${u.heightM ? `, ${u.heightM.toFixed(2)} m` : ''}`);
  if (u.dimensionsM) parts.push(u.dimensionsM.map((d) => `${Math.round(d * 10) / 10}`).join(' × ') + ' m');
  parts.push(formatBytes(u.bytes));
  return parts.join(' · ');
}

/**
 * The 3D row's Choose… and Change (docs/design/library.md#cast-elements-and-resources): the studio's 3D units of the
 * entity's kind only (figures for characters, sets for locations, props for props), archived ones left out; choosing
 * one pins its current version (an apply in mode `pin`).
 */
export function DeskPicker({ request, onClose }: { request: DeskRequest; onClose: () => void }) {
  const scope = useLibraryScope();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const query = useDebounced(q);
  const list = useLibraryList({ kinds: [request.deskKind], q: query, tag: tag || null, sort: 'name' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!scope) return null;
  const choose = async (item: LibraryItemSummary) => {
    setBusy(item.id);
    setError(null);
    try {
      const out = await libraryApi.apply(scope.projectId, {
        itemId: item.id,
        version: item.current,
        target: { kind: request.target.kind, id: request.target.id },
      });
      useUi.getState().toast(appliedText(out), 'success');
      scope.refresh();
      onClose();
    } catch (err) {
      setError(libraryErrorText(err));
    } finally {
      setBusy(null);
    }
  };
  const label = DESK_LABEL[request.deskKind];
  return (
    <Dialog open onClose={onClose} title={`${label} for ${request.target.name}`}>
      <div className="space-y-3" data-testid="desk-picker">
        <LibraryFilters q={q} onQ={setQ} tag={tag} onTag={setTag} tags={list.tags} testid="desk-picker" />
        {list.loading && !list.items.length ? <Spinner /> : null}
        {list.error ? <p className="text-[13px] text-danger">{list.error}</p> : null}
        {!list.loading && !list.items.length && !list.error ? (
          <EmptyState title={`No ${label}s in the library`}>
            Save one from the director's desk (its Library tab), then choose it here.
          </EmptyState>
        ) : null}
        <ul className="space-y-1.5">
          {list.items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-2 rounded-[var(--radius-control)] border border-border px-2 py-1.5"
              data-testid="desk-picker-item"
            >
              <LibraryThumb item={item} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{item.name}</div>
                <div className="truncate text-[11px] text-muted">
                  v{item.current} · {unitLine(item)}
                </div>
              </div>
              {item.id === request.currentItemId ? <Badge tone="accent">pinned</Badge> : null}
              <Button
                size="sm"
                variant="primary"
                loading={busy === item.id}
                disabled={!!busy || !scope.canEdit}
                onClick={() => choose(item)}
                data-testid="desk-picker-use"
              >
                Use v{item.current}
              </Button>
            </li>
          ))}
        </ul>
        {list.more ? (
          <Button size="sm" variant="ghost" onClick={list.loadMore}>
            Show more
          </Button>
        ) : null}
        {error ? (
          <p className="text-[13px] text-danger" role="alert" data-testid="desk-picker-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
