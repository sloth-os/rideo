import '../styles/index.css';
import { THEME_COLORS, ThemeSchema } from '@rideo/shared';
import { type ReactElement, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Studio } from '../App';
import { configureRuntime } from '../lib/runtime';
import { startPwa } from '../pwa/register';
import type { RideoHandle, RideoOptions, RideoTheme } from './types';

export type {
  RideoHandle,
  RideoOptions,
  RideoRouting,
  RideoTheme,
  RideoThemeColor,
  RideoThemeColors,
} from './types';

/**
 * The studio as a library (docs/design/embedding.md): the whole studio in another app's page, talking to a Rideo
 * server that may be on another origin, routed inside the host and themed to match it. One studio per page.
 */

declare global {
  // where the library's assets are, when the host serves them away from rideo.js (vite.lib.config.ts renderBuiltUrl)
  var __RIDEO_ASSETS__: string | undefined;
}

/** The theme tokens a theme may set (`colors`, `dark`, `light`). */
export const THEME_TOKENS: readonly string[] = THEME_COLORS;

/** Checks a theme (throws with the reason when it is not valid) and returns it. */
export function defineTheme(theme: RideoTheme): RideoTheme {
  return ThemeSchema.parse(theme) as RideoTheme;
}

const withSlash = (s: string) => (s.endsWith('/') ? s : `${s}/`);

let pwaStarted = false;

function configure(options: RideoOptions): void {
  const server = options.server
    ? withSlash(new URL(options.server, document.baseURI).href)
    : withSlash(new URL('./', document.baseURI).pathname);
  const basename =
    options.routing?.mode && options.routing.mode !== 'browser' ? '' : (options.routing?.basename ?? '');
  configureRuntime({
    apiBase: server,
    // the studio's own files ship inside the library (logo, font, ffmpeg cores): relative to its scripts
    assetBase: options.assetsBase ? withSlash(options.assetsBase) : server,
    routerBase: basename,
    embedded: true,
    ...(options.token !== undefined ? { token: options.token } : {}),
  });
  globalThis.__RIDEO_ASSETS__ = options.assetsBase
    ? withSlash(new URL(options.assetsBase, document.baseURI).href)
    : undefined;
  if (options.pwa && !pwaStarted) {
    pwaStarted = true;
    startPwa();
  }
}

/** The studio as a React component. */
export function RideoStudio(
  props: RideoOptions & { navigatorRef?: { current: ((path: string) => void) | null } },
): ReactElement {
  // set where the studio is before anything below renders (it reads the runtime while rendering)
  const configured = useRef<string | null>(null);
  const key = JSON.stringify([props.server, props.assetsBase, props.routing, typeof props.token]);
  if (configured.current !== key) {
    configure(props);
    configured.current = key;
  }
  const routing = useMemo(
    () => ({
      mode: props.routing?.mode ?? 'browser',
      basename: props.routing?.basename,
      initialPath: props.routing?.initialPath,
    }),
    [props.routing?.mode, props.routing?.basename, props.routing?.initialPath],
  );
  const theme = useMemo(() => (props.theme ? defineTheme(props.theme) : null), [props.theme]);
  return (
    <Studio
      routing={routing}
      theme={theme}
      chrome={props.chrome}
      embedded
      navigatorRef={props.navigatorRef}
      onNavigate={props.onNavigate}
    />
  );
}

/** Mounts the studio into an element of any page (React not required in the host's code). */
export function mountRideo(element: HTMLElement, options: RideoOptions = {}): RideoHandle {
  const root = createRoot(element);
  const navigatorRef: { current: ((path: string) => void) | null } = { current: null };
  let current = options;
  const render = () => root.render(<RideoStudio {...current} navigatorRef={navigatorRef} />);
  render();
  return {
    navigate(path) {
      navigatorRef.current?.(path);
    },
    setTheme(theme) {
      current = { ...current, theme };
      render();
    },
    unmount() {
      root.unmount();
    },
  };
}
