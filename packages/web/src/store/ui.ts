import type { Actor } from '@rideo/shared';
import { create } from 'zustand';
import type { LiveStatus } from '../lib/live';

export interface Toast {
  id: number;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
  actor?: Actor;
}

type Theme = 'dark' | 'light';

interface UiStore {
  toasts: Toast[];
  live: LiveStatus;
  theme: Theme;
  toast(message: string, level?: Toast['level'], actor?: Actor): void;
  dismiss(id: number): void;
  setLive(status: LiveStatus): void;
  setTheme(theme: Theme): void;
}

let nextId = 1;

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('rideo.theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // storage unavailable
  }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export const useUi = create<UiStore>((set, get) => ({
  toasts: [],
  live: 'connecting',
  theme: initialTheme(),
  toast(message, level = 'info', actor) {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, message, level, actor }].slice(-5) });
    setTimeout(() => get().dismiss(id), level === 'error' ? 8000 : 4500);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setLive(live) {
    set({ live });
  },
  setTheme(theme) {
    try {
      localStorage.setItem('rideo.theme', theme);
    } catch {
      // storage unavailable
    }
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
}));

/** Toasts a failed action with its problem detail. */
export function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  useUi.getState().toast(message, 'error');
}
