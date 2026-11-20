import type { ElementKind, LibraryItemSummary, LibraryKind } from '@rideo/shared';
import { Box, FolderOpen, MapPin, PersonStanding, Search, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cx, Input, Select } from '../../components/ui';
import { type LibraryQuery, libraryApi, libraryThumbnailUrl } from './api';
import { libraryErrorText } from './words';

/** The pieces the Library page and the pickers share: the list with its filters, thumbnails, element kinds. */

const ICONS: Record<LibraryKind, typeof Users> = {
  character: Users,
  element: MapPin,
  resource: FolderOpen,
  'desk-set': Box,
  'desk-prop': Box,
  'desk-figure': PersonStanding,
};

/** An item's thumbnail, or its kind's icon. */
export function LibraryThumb({
  item,
  className,
}: {
  item: Pick<LibraryItemSummary, 'id' | 'kind' | 'name' | 'thumbnail'>;
  className?: string;
}) {
  const url = libraryThumbnailUrl(item);
  const Icon = ICONS[item.kind];
  return (
    <span
      className={cx(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface-2 text-muted',
        className ?? 'size-10',
      )}
    >
      {url ? (
        <img src={url} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <Icon className="size-4" aria-hidden />
      )}
    </span>
  );
}

export interface LibraryListState {
  items: LibraryItemSummary[];
  /** Every tag the lists showed, for the tag filter. */
  tags: string[];
  loading: boolean;
  error: string | null;
  more: boolean;
  loadMore(): void;
  reload(): void;
}

/**
 * The items of a query, page by page; a new query starts again (search is debounced by the caller). Tags seen in any
 * answer feed the tag filter.
 */
export function useLibraryList(query: LibraryQuery, enabled = true): LibraryListState {
  const [items, setItems] = useState<LibraryItemSummary[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const key = JSON.stringify(query);
  const current = useRef(key);
  current.current = key;
  const fetchPage = useCallback(
    (cursor: string | null) => {
      const asked = key;
      setLoading(true);
      setError(null);
      libraryApi
        .list({ ...(JSON.parse(asked) as LibraryQuery), cursor })
        .then((page) => {
          if (current.current !== asked) return;
          setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
          setNext(page.next);
          setTags((prev) => [...new Set([...prev, ...page.items.flatMap((i) => i.tags)])].sort());
        })
        .catch((err) => current.current === asked && setError(libraryErrorText(err)))
        .finally(() => current.current === asked && setLoading(false));
    },
    [key],
  );
  // `round` asks for the first page again
  useEffect(() => {
    if (!enabled) return;
    fetchPage(null);
  }, [fetchPage, enabled, round]);
  return {
    items,
    tags,
    loading,
    error,
    more: next !== null,
    loadMore: () => next && fetchPage(next),
    reload: () => setRound((r) => r + 1),
  };
}

/** A value that follows `value` after `ms` without change (search as you type). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Search and tag filter in one row (wraps on phones). */
export function LibraryFilters({
  q,
  onQ,
  tag,
  onTag,
  tags,
  testid = 'library',
  children,
}: {
  q: string;
  onQ: (q: string) => void;
  tag: string;
  onTag: (tag: string) => void;
  tags: string[];
  testid?: string;
  children?: React.ReactNode;
}) {
  const options = tag && !tags.includes(tag) ? [...tags, tag].sort() : tags;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 basis-40">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" aria-hidden />
        <Input
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder="Search names, descriptions, tags"
          className="pl-8"
          aria-label="Search the library"
          data-testid={`${testid}-search`}
        />
      </div>
      <Select
        value={tag}
        onChange={(e) => onTag(e.target.value)}
        className="w-auto max-w-full min-w-0"
        aria-label="Tag"
        data-testid={`${testid}-tag`}
      >
        <option value="">All tags</option>
        {options.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </Select>
      {children}
    </div>
  );
}

/** Chips in a row that wraps (no sideways scroll on phones). */
export function Chips<T extends string>({
  value,
  options,
  onChange,
  testid,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  testid: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kinds" data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            'rounded-full border px-3 py-1 text-[12px] font-medium transition-colors duration-100',
            value === o.id
              ? 'border-accent/50 bg-accent/15 text-accent'
              : 'border-border bg-surface-2 text-muted hover:text-text',
          )}
          data-testid={`${testid}-${o.id}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Element kinds of element items, from their current versions' manifests (immutable: fetched once a version). */
const elementKinds = new Map<string, Promise<ElementKind | null>>();

export function elementKindOf(item: Pick<LibraryItemSummary, 'id' | 'current'>): Promise<ElementKind | null> {
  const key = `${item.id}@${item.current}`;
  let found = elementKinds.get(key);
  if (!found) {
    found = libraryApi.version(item.id, item.current).then(
      (v) => (v.kind === 'element' ? v.payload.kind : null),
      () => {
        elementKinds.delete(key);
        return null;
      },
    );
    elementKinds.set(key, found);
  }
  return found;
}

/** The element kinds of the listed element items, as they arrive (four manifests at a time). */
export function useElementKinds(items: LibraryItemSummary[]): Record<string, ElementKind | null> {
  const [kinds, setKinds] = useState<Record<string, ElementKind | null>>({});
  const wanted = useMemo(
    () => items.filter((i) => i.kind === 'element').map((i) => ({ id: i.id, current: i.current })),
    [items],
  );
  useEffect(() => {
    let live = true;
    const queue = [...wanted];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const kind = await elementKindOf(next);
        if (live) setKinds((k) => (k[next.id] === kind ? k : { ...k, [next.id]: kind }));
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => {
      live = false;
    };
  }, [wanted]);
  return kinds;
}
