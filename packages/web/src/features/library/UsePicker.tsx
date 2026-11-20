import type { ElementKind, LibraryItemSummary } from '@rideo/shared';
import { UserCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, cx, Dialog, EmptyState, Spinner } from '../../components/ui';
import { libraryApi } from './api';
import { type EntityKind, useLibraryScope } from './context';
import { Chips, LibraryFilters, LibraryThumb, useDebounced, useElementKinds, useLibraryList } from './parts';
import { appliedText, conflictOf, ELEMENT_CHIPS, libraryErrorText } from './words';

const TITLES: Record<EntityKind, string> = {
  character: 'Use characters from the library',
  element: 'Use places and props from the library',
  resource: 'Use resources from the library',
};

const ELEMENT_WORD: Record<ElementKind, string> = { location: 'location', prop: 'prop', style: 'style' };
const NONE: LibraryItemSummary[] = [];

interface Outcome {
  itemId: string;
  name: string;
  ok: boolean;
  text: string;
  /** A taken id or name: the entity it clashes with, to link to instead. */
  link?: { id: string; name: string };
}

/**
 * Use from library (docs/design/library.md#cast-elements-and-resources): the view's kind only (in Elements, chips for
 * locations, props and styles), filtered by tag and searchable, archived items left out; several items at once, used
 * one after the other with each result listed. What is checked stays checked under another search, tag or chip. An
 * item whose id or name the project already has offers "Link to the existing Mira" (its plan first); a real person asks
 * for the consent before anything is used.
 */
export function UsePicker({ entityKind, onClose }: { entityKind: EntityKind; onClose: () => void }) {
  const scope = useLibraryScope();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [elementKind, setElementKind] = useState<ElementKind | 'all'>('all');
  /** The checked items, in the order they were checked, whatever the list shows now. */
  const [selected, setSelected] = useState<ReadonlyMap<string, LibraryItemSummary>>(() => new Map());
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const query = useDebounced(q);
  const list = useLibraryList({ kinds: [entityKind], q: query, tag: tag || null, sort: 'name' });
  const kinds = useElementKinds(entityKind === 'element' ? list.items : NONE);
  const docs = scope?.docs;
  /** The items this project already uses (its entities linked to them). */
  const used = useMemo(() => {
    const ids = new Set<string>();
    if (!docs) return ids;
    const all = [
      ...Object.values(docs.characters),
      ...Object.values(docs.elements),
      ...Object.values(docs.resources),
    ];
    for (const e of all) if (e.library) ids.add(e.library.itemId);
    return ids;
  }, [docs]);
  if (!scope || !docs) return null;
  const shown = list.items.filter(
    (i) => entityKind !== 'element' || elementKind === 'all' || kinds[i.id] === elementKind,
  );
  const chosen = [...selected.values()];
  const needsConsent = chosen.some((i) => i.realPerson);
  /** The checked items the list does not show now (another search, tag or chip). */
  const hidden = chosen.filter((i) => !shown.some((s) => s.id === i.id));
  const toggle = (item: LibraryItemSummary) =>
    setSelected((s) => {
      const next = new Map(s);
      if (!next.delete(item.id)) next.set(item.id, item);
      return next;
    });
  const entityName = (kind: EntityKind, id: string) =>
    kind === 'character'
      ? docs.characters[id]?.name
      : kind === 'element'
        ? docs.elements[id]?.name
        : docs.resources[id]?.name;
  const use = async () => {
    setBusy(true);
    const results: Outcome[] = [];
    for (const item of chosen) {
      try {
        const out = await libraryApi.apply(scope.projectId, {
          itemId: item.id,
          ...(item.realPerson ? { acknowledgeConsent: consent } : {}),
        });
        results.push({ itemId: item.id, name: item.name, ok: true, text: appliedText(out) });
      } catch (err) {
        const c = conflictOf(err);
        const clash =
          (c?.reason === 'exists' || c?.reason === 'name') && c.entityId && entityKind !== 'resource'
            ? { id: c.entityId, name: entityName(entityKind, c.entityId) ?? item.name }
            : undefined;
        results.push({
          itemId: item.id,
          name: item.name,
          ok: false,
          text: libraryErrorText(err),
          ...(clash ? { link: clash } : {}),
        });
      }
      setOutcomes([...results]);
    }
    setSelected(new Map());
    setBusy(false);
    scope.refresh();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={TITLES[entityKind]}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="use-close">
            {outcomes.length ? 'Done' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!chosen.length || !scope.canEdit || (needsConsent && !consent)}
            onClick={use}
            data-testid="use-submit"
          >
            {chosen.length > 1 ? `Use ${chosen.length}` : 'Use'}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="use-picker">
        {entityKind === 'element' ? (
          <Chips value={elementKind} options={ELEMENT_CHIPS} onChange={setElementKind} testid="use-kind" />
        ) : null}
        <LibraryFilters q={q} onQ={setQ} tag={tag} onTag={setTag} tags={list.tags} testid="use" />
        {list.loading && !list.items.length ? <Spinner /> : null}
        {list.error ? <p className="text-[13px] text-danger">{list.error}</p> : null}
        {!list.loading && !shown.length && !list.error ? (
          <EmptyState title="Nothing here in the library">
            Save characters, places, props and resources to the library from their cards, in any project.
          </EmptyState>
        ) : null}
        <ul className="space-y-1.5">
          {shown.map((item) => (
            <PickRow
              key={item.id}
              item={item}
              checked={selected.has(item.id)}
              inProject={used.has(item.id)}
              elementKind={kinds[item.id] ?? null}
              onToggle={() => toggle(item)}
            />
          ))}
        </ul>
        {list.more ? (
          <Button size="sm" variant="ghost" onClick={list.loadMore}>
            Show more
          </Button>
        ) : null}
        {hidden.length ? (
          <p className="text-[12px] text-muted" data-testid="use-checked-elsewhere">
            Also checked: {hidden.map((i) => i.name).join(', ')}
          </p>
        ) : null}
        {needsConsent ? (
          <label
            className="flex items-start gap-2 rounded-[var(--radius-control)] border border-info/40 bg-info/10 px-3 py-2 text-[13px]"
            data-testid="use-consent"
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--color-accent)]"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              data-testid="use-consent-check"
            />
            <span>
              <span className="flex items-center gap-1 font-medium">
                <UserCheck className="size-3.5" /> A real person
              </span>
              The consent covers using this likeness and voice in this project.
            </span>
          </label>
        ) : null}
        {outcomes.length ? (
          <ul className="space-y-1.5" data-testid="use-results">
            {outcomes.map((o) => (
              <li
                key={o.itemId}
                className={cx(
                  'flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-[13px]',
                  o.ok ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10',
                )}
                data-testid="use-result"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{o.name}</span>: {o.text}
                </span>
                {o.link ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      scope.openPlan({
                        itemId: o.itemId,
                        target: {
                          kind: entityKind as 'character' | 'element',
                          id: o.link!.id,
                          name: o.link!.name,
                        },
                        fromVersion: null,
                      })
                    }
                    data-testid="use-link-existing"
                  >
                    Link to the existing {o.link.name}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}

function PickRow({
  item,
  checked,
  inProject,
  elementKind,
  onToggle,
}: {
  item: LibraryItemSummary;
  checked: boolean;
  inProject: boolean;
  elementKind: ElementKind | null;
  onToggle: () => void;
}) {
  return (
    <li>
      <label
        className={cx(
          'flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border px-2 py-1.5',
          checked ? 'border-accent bg-accent/10' : 'border-border',
        )}
        data-testid="use-item"
      >
        <input
          type="checkbox"
          className="accent-[var(--color-accent)]"
          checked={checked}
          onChange={onToggle}
          aria-label={`Use ${item.name}`}
          data-testid="use-item-check"
        />
        <LibraryThumb item={item} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{item.name}</span>
          <span className="block truncate text-[11px] text-muted">
            v{item.current}
            {elementKind ? ` · ${ELEMENT_WORD[elementKind]}` : ''}
            {item.tags.length ? ` · ${item.tags.join(', ')}` : ''}
          </span>
        </span>
        {item.realPerson ? (
          <Badge tone="info" title="A real person: the consent is confirmed when it is used">
            <UserCheck className="size-3" /> real person
          </Badge>
        ) : null}
        {inProject ? <Badge>in this project</Badge> : null}
      </label>
    </li>
  );
}
