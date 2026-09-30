import { useEffect, useRef, useState } from 'react';
import { reportError } from '../store/ui';
import { Input, Textarea } from './ui';

interface EditableProps {
  value: string;
  onSave: (value: string) => Promise<unknown>;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  rows?: number;
  name?: string;
  ariaLabel?: string;
}

/**
 * Local-state text field that saves on blur (or Enter for single lines). Remote changes (live commits)
 * replace the value only while the field is not being edited, so collaborators never clobber typing.
 */
export function Editable({
  value,
  onSave,
  placeholder,
  className,
  multiline,
  rows,
  name,
  ariaLabel,
}: EditableProps) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const commit = () => {
    editing.current = false;
    if (draft !== value)
      onSave(draft).catch((err) => {
        reportError(err);
        setDraft(value);
      });
  };
  const common = {
    value: draft,
    placeholder,
    name,
    'aria-label': ariaLabel ?? placeholder ?? name,
    onFocus: () => {
      editing.current = true;
    },
    onBlur: commit,
  };
  return multiline ? (
    <Textarea {...common} rows={rows ?? 3} className={className} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <Input
      {...common}
      className={className}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
