import type { Notification } from '@rideo/shared';
import { create } from 'zustand';
import { api } from '../lib/api';

/** The signed-in person's notifications (docs/design/review.md#notifications): loaded once, then pushed live. */
interface NotificationState {
  items: Notification[];
  unread: number;
  loaded: boolean;
  load(): Promise<void>;
  push(n: Notification): void;
  markRead(ids?: string[]): Promise<void>;
}

export const useNotifications = create<NotificationState>((set, get) => ({
  items: [],
  unread: 0,
  loaded: false,
  async load() {
    try {
      const r = await api.notifications(50);
      set({ items: r.notifications, unread: r.unread, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  push(n) {
    if (get().items.some((x) => x.id === n.id)) return;
    set((s) => ({ items: [n, ...s.items].slice(0, 50), unread: s.unread + (n.read ? 0 : 1) }));
  },
  async markRead(ids) {
    set((s) => ({
      items: s.items.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)),
    }));
    const r = await api.markNotificationsRead(ids).catch(() => null);
    set((s) => ({ unread: r ? r.unread : s.items.filter((n) => !n.read).length }));
  },
}));
