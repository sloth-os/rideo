import { mergeThemes, type Theme, themeStyle } from '@rideo/shared';
import { type CSSProperties, type ReactNode, useEffect, useMemo } from 'react';
import { useConfig } from '../lib/config';
import { StudioContext, type StudioShell } from '../lib/studio-context';
import { useUi } from '../store/ui';

/**
 * The studio's root element (docs/design/embedding.md#themes): `.rideo-root` with the mode and the theme's custom
 * properties, the host's theme over the studio's (RIDEO_THEME) over the brand tokens. A person's own light/dark
 * choice wins over the theme's default mode. Standalone, the page's background follows it too.
 */
export function ThemeRoot({
  theme,
  chrome,
  embedded,
  children,
}: {
  theme?: Theme | null;
  chrome?: Partial<StudioShell['chrome']>;
  embedded: boolean;
  children: ReactNode;
}) {
  const config = useConfig();
  const chosen = useUi((s) => s.themeChosen);
  const own = useUi((s) => s.theme);
  const effective = useMemo(() => mergeThemes(config?.theme, theme), [config?.theme, theme]);
  const mode = !chosen && (effective.mode === 'dark' || effective.mode === 'light') ? effective.mode : own;
  const style = useMemo(() => themeStyle(effective, mode) as CSSProperties, [effective, mode]);
  useEffect(() => {
    if (!embedded) document.documentElement.dataset.theme = mode;
  }, [embedded, mode]);
  const shell = useMemo<StudioShell>(
    () => ({ theme: effective, mode, chrome: { header: chrome?.header ?? true }, embedded }),
    [effective, mode, chrome?.header, embedded],
  );
  return (
    <StudioContext.Provider value={shell}>
      <div className="rideo-root" data-theme={mode} style={style} data-testid="rideo-root">
        {children}
      </div>
    </StudioContext.Provider>
  );
}
