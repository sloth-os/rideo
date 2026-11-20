import {
  type DigestLibraryUse,
  isDeskUnitKind,
  type LibraryItem,
  type LibraryItemPatch,
  type LibraryKind,
  type LibraryUses,
  type LibraryVersion,
} from '@rideo/shared';
import { Archive, ArchiveRestore, ArrowLeft, LibraryBig, UserCheck, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Editable } from '../../components/Editable';
import { Badge, Button, Card, cx, EmptyState, Input, SectionHeader, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useUi } from '../../store/ui';
import { AppHeader } from '../workspace/AppHeader';
import { mayManage } from './access';
import { libraryApi } from './api';
import { unitLine } from './DeskPicker';
import { Chips, LibraryFilters, LibraryThumb, useDebounced, useLibraryList } from './parts';
import {
  changeErrorText,
  deskMoves,
  KIND_CHIPS,
  KIND_LABEL,
  libraryErrorText,
  type MoveResult,
  moveEverywhere,
  moveEverywhereLabel,
  parseTags,
  usageText,
} from './words';

/**
 * The Library page (docs/design/library.md#the-library-page), `/library` and `/library/:itemId`: on a wide screen the
 * list (kind chips, tag filter, search, Show archived) beside the item; on a phone the list, then the item on its own
 * route with its actions in a bar at the bottom. The item: thumbnail, name, description and tags (its owner and
 * admins change them), its versions (Make current), where it is used (Use vN per project for 3D units, and Use vN in
 * all N projects), Archive and Unarchive. Nothing is uploaded here.
 */
export function LibraryPage() {
  const { itemId } = useParams();
  const [chip, setChip] = useState('all');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [archived, setArchived] = useState(false);
  const query = useDebounced(q);
  const kinds = KIND_CHIPS.find((c) => c.id === chip)?.kinds ?? null;
  const list = useLibraryList({ kinds, q: query, tag: tag || null, archived, sort: 'name' });
  const reloadList = list.reload;
  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-3 py-4 sm:px-6" data-testid="library-page">
        <div className={cx(itemId && 'hidden md:block')}>
          <SectionHeader
            title="Library"
            subtitle="Characters, places, props, resources and 3D units the studio's projects share, in versions. Save them from a project's cards or the director's desk; use them from Cast, Elements and Resources."
          />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <section
            className={cx('min-w-0 space-y-3', itemId && 'hidden md:block')}
            data-testid="library-list"
          >
            <Chips value={chip} options={KIND_CHIPS} onChange={setChip} testid="library-kind" />
            <LibraryFilters q={q} onQ={setQ} tag={tag} onTag={setTag} tags={list.tags}>
              <label className="flex items-center gap-1.5 text-[12px] text-muted">
                <input
                  type="checkbox"
                  className="accent-[var(--color-accent)]"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                  data-testid="library-show-archived"
                />
                Show archived
              </label>
            </LibraryFilters>
            {list.error ? <p className="text-[13px] text-danger">{list.error}</p> : null}
            {list.loading && !list.items.length ? <Spinner /> : null}
            {!list.loading && !list.items.length && !list.error ? (
              <EmptyState icon={<LibraryBig className="size-8" />} title="Nothing in the library here">
                Save a character, place, prop or resource from its card in a project, or a 3D set, prop or
                figure from the director's desk.
              </EmptyState>
            ) : null}
            <ul className="space-y-1.5">
              {list.items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={`/library/${item.id}`}
                    className={cx(
                      'flex items-center gap-2 rounded-[var(--radius-control)] border px-2 py-1.5 hover:border-muted',
                      item.id === itemId ? 'border-accent bg-accent/10' : 'border-border bg-surface',
                    )}
                    data-testid="library-item"
                    data-item-id={item.id}
                  >
                    <LibraryThumb item={item} />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[13px] font-medium"
                        data-testid="library-item-name"
                      >
                        {item.name}
                      </span>
                      <span className="block truncate text-[11px] text-muted">
                        {KIND_LABEL[item.kind]} · v{item.current}
                        {item.tags.length ? ` · ${item.tags.join(', ')}` : ''}
                      </span>
                    </span>
                    {item.archived ? <Badge>archived</Badge> : null}
                  </Link>
                </li>
              ))}
            </ul>
            {list.more ? (
              <Button size="sm" variant="ghost" onClick={list.loadMore}>
                Show more
              </Button>
            ) : null}
          </section>
          <section className={cx('min-w-0', !itemId && 'hidden md:block')}>
            {itemId ? (
              <ItemDetail key={itemId} itemId={itemId} onChanged={reloadList} />
            ) : (
              <EmptyState title="Choose an item">
                Its versions, the projects that use it and what can be done with it show here.
              </EmptyState>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function ItemDetail({ itemId, onChanged }: { itemId: string; onChanged: () => void }) {
  const me = useAuth((s) => s.me);
  const [item, setItem] = useState<LibraryItem | null>(null);
  const [version, setVersion] = useState<LibraryVersion | null>(null);
  const [uses, setUses] = useState<LibraryUses | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MoveResult[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const loadUses = useCallback(
    () => libraryApi.uses(itemId).then(setUses, (err) => setError(libraryErrorText(err))),
    [itemId],
  );
  /** Reads the item (and its current version); false when it could not, the error said. */
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const it = await libraryApi.get(itemId);
      setItem(it);
      setError(null);
      libraryApi.version(itemId, it.current).then(setVersion, () => setVersion(null));
      return true;
    } catch (err) {
      setError(libraryErrorText(err));
      return false;
    }
  }, [itemId]);
  useEffect(() => {
    void load();
    void loadUses();
  }, [load, loadUses]);
  if (!item)
    return error ? (
      <p className="text-[13px] text-danger" role="alert">
        {error}
      </p>
    ) : (
      <Spinner />
    );
  const manage = mayManage(me, item.ownerId);
  const desk = isDeskUnitKind(item.kind);
  const patch = async (change: LibraryItemPatch) => {
    setBusy(true);
    try {
      const next = await libraryApi.update(item.id, change, item.rev);
      setItem(next);
      setError(null);
      onChanged();
      if (change.current !== undefined)
        libraryApi.version(item.id, next.current).then(setVersion, () => undefined);
    } catch (err) {
      // the item as it is now, then what was refused (reading it clears the error)
      if (await load()) setError(changeErrorText(err));
      throw err;
    } finally {
      setBusy(false);
    }
  };
  const moves = uses ? deskMoves(uses, item.current) : [];
  const runMoves = async (which: typeof moves) => {
    setBusy(true);
    setResults([]);
    const out = await moveEverywhere(
      which,
      item.id,
      item.current,
      (projectId, input) => libraryApi.apply(projectId, input),
      (r) => setResults((prev) => [...prev, r]),
    );
    setBusy(false);
    const applied = out.filter((r) => r.outcome === 'applied').length;
    useUi
      .getState()
      .toast(
        `${item.name} v${item.current}: ${applied} pin${applied === 1 ? '' : 's'} moved`,
        out.some((r) => r.outcome === 'refused') ? 'warning' : 'success',
      );
    await loadUses();
  };
  const tags = item.tags;
  const addTag = () => {
    const { tags: more, invalid } = parseTags(tagDraft);
    if (invalid.length) {
      setError(`Not a tag: ${invalid.join(', ')} (1–40 lower-case letters, digits, spaces, _ . -)`);
      return;
    }
    if (!more.length) return;
    void patch({ tags: [...new Set([...tags, ...more])] }).then(
      () => setTagDraft(''),
      () => undefined,
    );
  };
  const actions = (
    <>
      {desk && moves.length ? (
        <Button
          variant="primary"
          loading={busy}
          onClick={() => runMoves(moves)}
          data-testid="library-use-everywhere"
        >
          {moveEverywhereLabel(item.current, moves.length)}
        </Button>
      ) : null}
      {manage ? (
        item.archived ? (
          <Button
            icon={<ArchiveRestore className="size-4" />}
            disabled={busy}
            onClick={() => patch({ archived: false }).catch(() => undefined)}
            data-testid="library-unarchive"
          >
            Unarchive
          </Button>
        ) : (
          <Button
            variant="danger"
            icon={<Archive className="size-4" />}
            disabled={busy}
            title="Hidden from pickers; the projects that use it keep working"
            onClick={() => patch({ archived: true }).catch(() => undefined)}
            data-testid="library-archive"
          >
            Archive
          </Button>
        )
      ) : null}
    </>
  );
  return (
    <div className="space-y-4 pb-24 md:pb-0" data-testid="library-detail" data-item-id={item.id}>
      <Link
        to="/library"
        className="inline-flex items-center gap-1 text-[13px] text-muted md:hidden"
        data-testid="library-back"
      >
        <ArrowLeft className="size-4" /> Library
      </Link>
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <LibraryThumb item={item} className="size-24" />
          <div className="min-w-0 flex-1 space-y-1.5">
            {manage ? (
              <Editable
                value={item.name}
                onSave={(name) => patch({ name: name.trim() || item.name })}
                ariaLabel="Name"
                className="font-semibold"
              />
            ) : (
              <h2
                className="text-xl font-semibold tracking-tight break-words"
                data-testid="library-detail-name"
              >
                {item.name}
              </h2>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge>{KIND_LABEL[item.kind]}</Badge>
              <Badge tone="accent">current v{item.current}</Badge>
              {item.archived ? <Badge testid="library-archived">archived</Badge> : null}
              {item.realPerson ? (
                <Badge tone="info" title="A real person: using it asks for the consent">
                  <UserCheck className="size-3" /> real person
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
        {manage ? (
          <Editable
            value={item.description}
            multiline
            rows={2}
            placeholder="What it is, where it is used"
            onSave={(description) => patch({ description })}
            ariaLabel="Description"
          />
        ) : item.description ? (
          <p className="text-[13px] text-muted">{item.description}</p>
        ) : null}
        <VersionFacts kind={item.kind} version={version} />
        <div className="flex flex-wrap items-center gap-1.5" data-testid="library-tags">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[12px]"
              data-testid="library-item-tag"
            >
              {t}
              {manage ? (
                <button
                  type="button"
                  className="text-muted hover:text-text"
                  aria-label={`Remove the tag ${t}`}
                  onClick={() => patch({ tags: tags.filter((x) => x !== t) }).catch(() => undefined)}
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          ))}
          {manage ? (
            <form
              className="flex min-w-0 items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                addTag();
              }}
            >
              <Input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                placeholder="Add a tag"
                className="h-7 w-32 text-[12px]"
                aria-label="Add a tag"
                data-testid="library-tag-input"
              />
              <Button type="submit" size="sm" className="h-7" disabled={!tagDraft.trim() || busy}>
                Add
              </Button>
            </form>
          ) : null}
          {!tags.length && !manage ? <span className="text-[12px] text-muted">No tags</span> : null}
        </div>
      </Card>
      {error ? (
        <p className="text-[13px] text-danger" role="alert" data-testid="library-error">
          {error}
        </p>
      ) : null}
      <Card className="p-4">
        <h3 className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Versions</h3>
        <ul className="space-y-1.5">
          {[...item.history].reverse().map((h) => (
            <li
              key={h.version}
              className="flex flex-wrap items-center gap-2 text-[13px]"
              data-testid="library-version"
            >
              <span className="font-mono font-medium">v{h.version}</span>
              <span className="text-muted">
                {h.createdAt.slice(0, 10)} · {h.createdBy.name || h.createdBy.id}
                {h.note ? ` · ${h.note}` : ''}
              </span>
              {h.version === item.current ? <Badge tone="accent">current</Badge> : null}
              {manage && h.version !== item.current ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={busy}
                  onClick={() => patch({ current: h.version }).catch(() => undefined)}
                  data-testid="library-make-current"
                >
                  Make current
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-4">
        <h3 className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Used in</h3>
        <UsedIn
          uses={uses}
          desk={desk}
          current={item.current}
          busy={busy}
          onUse={(projectId) => runMoves(moves.filter((m) => m.projectId === projectId))}
          moves={moves.map((m) => m.projectId)}
        />
        {results.length ? (
          <ul className="mt-3 space-y-1" data-testid="library-use-results">
            {results.map((r, i) => (
              <li
                key={`${r.projectId}-${r.entity ?? ''}-${i}`}
                className={cx(
                  'text-[13px]',
                  r.outcome === 'refused' ? 'text-danger' : r.outcome === 'skipped' ? 'text-muted' : '',
                )}
                data-testid="library-use-result"
                data-outcome={r.outcome}
              >
                {r.text}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      <div
        className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap justify-end gap-2 border-t border-border bg-surface px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:static md:z-auto md:border-0 md:bg-transparent md:p-0"
        data-testid="library-actions"
      >
        {actions}
      </div>
    </div>
  );
}

/** What the current version is, beyond its name. */
function VersionFacts({ kind, version }: { kind: LibraryKind; version: LibraryVersion | null }) {
  if (!version) return null;
  let text = '';
  switch (version.kind) {
    case 'character':
      text = `${version.payload.role} · ${version.payload.summary}`;
      break;
    case 'element':
      text = `${version.payload.kind}${version.payload.aliases.length ? ` · also called ${version.payload.aliases.join(', ')}` : ''}`;
      break;
    case 'resource':
      text = `${version.payload.kind} · ${version.payload.role}${version.payload.notes ? ` · ${version.payload.notes}` : ''}`;
      break;
    default: {
      const meta = version.payload.meta;
      text = [
        unitLine({
          unit: {
            sha256: version.digest,
            bytes: version.payload.payload.size,
            format: version.payload.format,
            formatVersion: version.payload.formatVersion,
            actorKind: meta.actor?.kind ?? null,
            heightM: meta.actor?.heightM ?? null,
            dimensionsM: meta.dimensionsM,
          },
        }),
        `${meta.objects} objects`,
        meta.credits.length ? `${meta.credits.length} credits` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    }
  }
  return (
    <p className="text-[13px] text-muted" data-testid="library-facts" data-kind={kind}>
      {text}
    </p>
  );
}

const ENTITY_VIEW = { character: 'cast', element: 'elements', resource: 'resources' } as const;

function UsedIn({
  uses,
  desk,
  current,
  busy,
  moves,
  onUse,
}: {
  uses: LibraryUses | null;
  desk: boolean;
  current: number;
  busy: boolean;
  /** The projects whose pins are at another version. */
  moves: string[];
  onUse: (projectId: string) => void;
}) {
  if (!uses) return <Spinner />;
  return (
    <div className="space-y-2" data-testid="library-uses">
      {uses.projects.length === 0 ? <p className="text-[13px] text-muted">No project uses it yet.</p> : null}
      {uses.projects.map((p) => (
        <div
          key={p.projectId}
          className="rounded-[var(--radius-control)] border border-border px-3 py-2"
          data-testid="library-use-project"
          data-project-id={p.projectId}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/p/${p.projectId}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
              {p.title}
            </Link>
            <Badge>{p.role}</Badge>
            {desk && moves.includes(p.projectId) ? (
              <Button
                size="sm"
                className="h-7"
                disabled={busy}
                onClick={() => onUse(p.projectId)}
                data-testid="library-use-version"
              >
                Use v{current}
              </Button>
            ) : null}
          </div>
          <ul className="mt-1 space-y-0.5">
            {p.uses.map((u: DigestLibraryUse, i) => (
              <li key={`${u.via}-${u.entity?.id ?? i}-${u.version}`} className="text-[12px] text-muted">
                {u.entity ? (
                  <Link to={`/p/${p.projectId}/${ENTITY_VIEW[u.entity.kind]}`} className="hover:text-text">
                    {usageText(u)}
                  </Link>
                ) : (
                  usageText(u)
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {uses.incomplete ? (
        <p className="text-[12px] text-muted" data-testid="library-uses-incomplete">
          Some projects could not be read: projects kept in browsers count only while their tab is open.
        </p>
      ) : null}
    </div>
  );
}
