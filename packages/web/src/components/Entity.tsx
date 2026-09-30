import type { FocusKind } from '@rideo/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useProject } from '../store/project';
import { cx } from './ui';

/**
 * Wraps a domain entity: carries `data-entity="<kind>:<id>"`, scrolls into view and pulses when an agent
 * focuses it (ui_focus) or someone else changes it (live commit).
 */
export function Entity({
  kind,
  id,
  children,
  className,
  as = 'div',
}: {
  kind: FocusKind;
  id: string;
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li' | 'section' | 'article';
}) {
  const ref = useRef<HTMLElement>(null);
  const highlight = useProject((s) =>
    s.highlight?.kind === kind && s.highlight.id === id ? s.highlight.at : 0,
  );
  const touched = useProject((s) => s.touched[`${kind}:${id}`] ?? 0);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!highlight) return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setPulse(highlight);
  }, [highlight]);
  useEffect(() => {
    if (touched && Date.now() - touched < 3000) setPulse(touched);
  }, [touched]);
  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(0), 2600);
    return () => clearTimeout(t);
  }, [pulse]);
  const Tag = as;
  return (
    <Tag
      ref={ref as never}
      data-entity={`${kind}:${id}`}
      data-highlighted={pulse ? 'true' : undefined}
      className={cx(className, pulse > 0 && 'pulse')}
    >
      {children}
    </Tag>
  );
}
