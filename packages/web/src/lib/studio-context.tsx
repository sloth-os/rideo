import type { Theme } from '@rideo/shared';
import { createContext, useContext } from 'react';

/**
 * How this studio is shown (docs/design/embedding.md): its effective theme (the host's over the studio's), whether
 * it draws its own header, and whether it lives in another app's page.
 */
export interface StudioShell {
  theme: Theme;
  /** The mode shown now (the person's choice, else the theme's default, else the device's). */
  mode: 'dark' | 'light';
  chrome: { header: boolean };
  embedded: boolean;
}

export const StudioContext = createContext<StudioShell>({
  theme: {},
  mode: 'dark',
  chrome: { header: true },
  embedded: false,
});

export function useStudioShell(): StudioShell {
  return useContext(StudioContext);
}
