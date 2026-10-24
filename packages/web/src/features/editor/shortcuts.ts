/**
 * The editor's keymap (docs/design/editing-tools.md#shortcuts): one table drives the keys and the `?` dialog.
 * `mod` is Ctrl, or ⌘ on a Mac.
 */
export type EditorAction =
  | 'playPause'
  | 'pause'
  | 'play'
  | 'reverse'
  | 'frameBack'
  | 'frameForward'
  | 'secondBack'
  | 'secondForward'
  | 'previousEdit'
  | 'nextEdit'
  | 'start'
  | 'end'
  | 'split'
  | 'delete'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'undo'
  | 'redo'
  | 'addMarker'
  | 'nextMarker'
  | 'previousMarker'
  | 'snap'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'nudgeBack'
  | 'nudgeForward'
  | 'deselect'
  | 'help';

export interface KeyChord {
  /** `KeyboardEvent.key`, letters lower case. */
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Shortcut {
  action: EditorAction;
  label: string;
  keys: KeyChord[];
}

const k = (key: string, mods: Omit<KeyChord, 'key'> = {}): KeyChord => ({ key, ...mods });

export const SHORTCUTS: readonly Shortcut[] = [
  { action: 'playPause', label: 'Play / pause', keys: [k(' ')] },
  { action: 'pause', label: 'Pause', keys: [k('k')] },
  { action: 'play', label: 'Play', keys: [k('l')] },
  { action: 'reverse', label: 'Play backwards', keys: [k('j')] },
  { action: 'frameBack', label: 'One frame back', keys: [k('ArrowLeft')] },
  { action: 'frameForward', label: 'One frame forward', keys: [k('ArrowRight')] },
  { action: 'secondBack', label: 'One second back', keys: [k('ArrowLeft', { shift: true })] },
  { action: 'secondForward', label: 'One second forward', keys: [k('ArrowRight', { shift: true })] },
  { action: 'previousEdit', label: 'Previous edit point', keys: [k('ArrowUp')] },
  { action: 'nextEdit', label: 'Next edit point', keys: [k('ArrowDown')] },
  { action: 'start', label: 'Go to start', keys: [k('Home')] },
  { action: 'end', label: 'Go to end', keys: [k('End')] },
  {
    action: 'split',
    label: 'Split at the playhead',
    keys: [k('s'), k('k', { mod: true }), k('b', { mod: true })],
  },
  { action: 'delete', label: 'Delete', keys: [k('Delete'), k('Backspace')] },
  { action: 'copy', label: 'Copy', keys: [k('c', { mod: true })] },
  { action: 'cut', label: 'Cut', keys: [k('x', { mod: true })] },
  { action: 'paste', label: 'Paste at the playhead', keys: [k('v', { mod: true })] },
  { action: 'duplicate', label: 'Duplicate', keys: [k('d', { mod: true })] },
  { action: 'undo', label: 'Undo', keys: [k('z', { mod: true })] },
  { action: 'redo', label: 'Redo', keys: [k('z', { mod: true, shift: true }), k('y', { mod: true })] },
  { action: 'addMarker', label: 'Add a marker', keys: [k('m')] },
  { action: 'nextMarker', label: 'Next marker', keys: [k('m', { shift: true })] },
  { action: 'previousMarker', label: 'Previous marker', keys: [k('m', { mod: true, shift: true })] },
  { action: 'snap', label: 'Snapping on / off', keys: [k('n')] },
  { action: 'zoomIn', label: 'Zoom in', keys: [k('+'), k('=')] },
  { action: 'zoomOut', label: 'Zoom out', keys: [k('-')] },
  { action: 'zoomFit', label: 'Zoom to fit', keys: [k('\\')] },
  { action: 'nudgeBack', label: 'Nudge earlier', keys: [k('ArrowLeft', { alt: true })] },
  { action: 'nudgeForward', label: 'Nudge later', keys: [k('ArrowRight', { alt: true })] },
  { action: 'deselect', label: 'Deselect', keys: [k('Escape')] },
  { action: 'help', label: 'Keyboard shortcuts', keys: [k('?')] },
];

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

/** Symbols are typed with or without Shift depending on the layout: Shift does not count for them. */
const isSymbol = (key: string) => key.length === 1 && !/[a-z0-9 ]/i.test(key);

function matches(chord: KeyChord, e: KeyEventLike): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key !== chord.key) return false;
  if (!!chord.mod !== (e.ctrlKey || e.metaKey)) return false;
  if (!!chord.alt !== e.altKey) return false;
  return isSymbol(chord.key) || !!chord.shift === e.shiftKey;
}

/** The action of a key press, or null. */
export function actionFor(e: KeyEventLike): EditorAction | null {
  for (const s of SHORTCUTS) if (s.keys.some((c) => matches(c, e))) return s.action;
  return null;
}

const NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
};

/** How a chord is written: `Ctrl+Shift+Z`, `⌘⇧Z` on a Mac. */
export function chordLabel(chord: KeyChord, mac: boolean): string {
  const key = NAMES[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  if (mac) return `${chord.mod ? '⌘' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${key}`;
  return [chord.mod && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', key].filter(Boolean).join('+');
}

/** The keys of an action as the dialog and the menus show them. */
export function keysOf(action: EditorAction, mac: boolean): string[] {
  return SHORTCUTS.find((s) => s.action === action)?.keys.map((c) => chordLabel(c, mac)) ?? [];
}

/** Whether a key press comes from a field (where keys type, not edit). */
export function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  );
}

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
