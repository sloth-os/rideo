import type { Element, ElementKind } from '@rideo/shared';
import { Lock, MapPin, Package, Palette, X } from 'lucide-react';
import { NO_ELEMENTS, useProject } from '../store/project';
import { cx, Select } from './ui';

export const ELEMENT_ICON = { location: MapPin, prop: Package, style: Palette } as const;

/** One element as a chip (lock state shown, removable). */
export function ElementChip({ element, onRemove }: { element: Element; onRemove?: () => void }) {
  const Icon = ELEMENT_ICON[element.kind];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        element.lock.locked ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10',
      )}
      title={element.lock.locked ? `${element.name} (locked)` : `${element.name} (not locked yet)`}
      data-testid="element-chip"
    >
      <Icon className="size-3" />
      {element.name}
      {element.lock.locked ? <Lock className="size-2.5" /> : null}
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${element.name}`} className="text-muted">
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Picks elements for a scene or a shot (docs/design/elements.md#where-elements-are-used): chips for the chosen
 * ones and a select to add more of the allowed kinds.
 */
export function ElementPicker({
  value,
  kinds,
  onChange,
  label,
  testid,
}: {
  value: string[];
  kinds: ElementKind[];
  onChange: (ids: string[]) => void;
  label: string;
  testid?: string;
}) {
  const elements = useProject((s) => s.docs?.elements ?? NO_ELEMENTS);
  const chosen = value.map((id) => elements[id]).filter((e): e is Element => !!e);
  const options = Object.values(elements)
    .filter((e) => kinds.includes(e.kind) && !value.includes(e.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={testid}>
      {chosen.map((e) => (
        <ElementChip key={e.id} element={e} onRemove={() => onChange(value.filter((x) => x !== e.id))} />
      ))}
      {options.length ? (
        <Select
          value=""
          onChange={(ev) => ev.target.value && onChange([...value, ev.target.value])}
          className="h-7 w-auto px-2 text-[11px]"
          aria-label={label}
        >
          <option value="">+ {label}</option>
          {options.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
