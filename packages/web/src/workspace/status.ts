import { create } from 'zustand';

/** Whether this browser keeps the studio's projects, and whether the server serves them now. */
interface WorkspaceStatus {
  enabled: boolean;
  /** The server listed this browser's projects (after every connect): views reload what they show. */
  ready: number;
  setEnabled(enabled: boolean): void;
  markReady(): void;
}

export const useWorkspaceStatus = create<WorkspaceStatus>((set) => ({
  enabled: false,
  ready: 0,
  setEnabled: (enabled) => set({ enabled }),
  markReady: () => set((s) => ({ ready: s.ready + 1 })),
}));
