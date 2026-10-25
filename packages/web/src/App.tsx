import type { Theme } from '@rideo/shared';
import { type RefObject, useEffect, useRef } from 'react';
import {
  BrowserRouter,
  HashRouter,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router';
import { ThemeRoot } from './components/ThemeRoot';
import { Toaster } from './components/Toaster';
import { Spinner } from './components/ui';
import { AdminPage } from './features/account/AdminPage';
import { BrandKitsPage } from './features/account/BrandKitsPage';
import { LoginPage } from './features/account/LoginPage';
import { TokensPage } from './features/account/TokensPage';
import { Dashboard } from './features/dashboard/Dashboard';
import { InboxPage } from './features/inbox/InboxPage';
import { GuestReviewPage } from './features/review/GuestReviewPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { VerifyPage } from './features/verify/VerifyPage';
import { Workspace } from './features/workspace/Workspace';
import { loginUrl, useAuth } from './lib/auth';
import { LiveBridge } from './lib/live-bridge';
import { getRuntime } from './lib/runtime';
import { startTelemetry } from './lib/telemetry';

/** With accounts, everything but sign-in and verification needs a signed-in person (docs/design/accounts.md). */
function Signed({ children }: { children: React.ReactNode }) {
  const { me, loaded } = useAuth();
  const location = useLocation();
  if (!loaded)
    return (
      <div className="flex min-h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (me?.mode === 'oidc' && !me.user)
    return <Navigate to={loginUrl(location.pathname + location.search)} replace />;
  return <>{children}</>;
}

/** Guests of a review link have no live channel (and no session to open one with). */
function Live() {
  const location = useLocation();
  return location.pathname.startsWith('/review/') ? null : <LiveBridge />;
}

/** How the studio routes (docs/design/embedding.md#options). */
export interface StudioRouting {
  mode?: 'browser' | 'hash' | 'memory';
  basename?: string;
  initialPath?: string;
}

/** The host's handle on the router: navigate from outside, hear every route change. */
function RouterBridge({
  navigatorRef,
  onNavigate,
}: {
  navigatorRef?: RefObject<((path: string) => void) | null>;
  onNavigate?: (path: string) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  // the latest callback, so a host passing a new function on each render hears each route change once
  const heard = useRef(onNavigate);
  heard.current = onNavigate;
  useEffect(() => {
    if (navigatorRef) navigatorRef.current = (path) => void navigate(path);
  }, [navigate, navigatorRef]);
  useEffect(() => {
    heard.current?.(location.pathname + location.search);
  }, [location.pathname, location.search]);
  return null;
}

/**
 * The whole studio: its routes inside a router of the chosen kind, in its themed root (docs/design/embedding.md).
 * The standalone app is this with the browser's URL under the page's base (docs/design/subpath.md).
 */
export function Studio({
  routing = {},
  theme,
  chrome,
  embedded = false,
  navigatorRef,
  onNavigate,
}: {
  routing?: StudioRouting;
  theme?: Theme | null;
  chrome?: { header?: boolean };
  embedded?: boolean;
  navigatorRef?: RefObject<((path: string) => void) | null>;
  onNavigate?: (path: string) => void;
}) {
  const load = useAuth((s) => s.load);
  useEffect(() => {
    void load();
    // What only the browser knows: vitals, waits, errors (docs/design/observability.md#telemetry-from-the-studio)
    startTelemetry();
  }, [load]);
  const mode = routing.mode ?? 'browser';
  const basename = routing.basename?.replace(/\/+$/, '') || undefined;
  const routes = (
    <>
      <Live />
      <RouterBridge navigatorRef={navigatorRef} onNavigate={onNavigate} />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/review/:token" element={<GuestReviewPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route
          path="/"
          element={
            <Signed>
              <Dashboard />
            </Signed>
          }
        />
        <Route
          path="/tokens"
          element={
            <Signed>
              <TokensPage />
            </Signed>
          }
        />
        <Route
          path="/admin"
          element={
            <Signed>
              <AdminPage />
            </Signed>
          }
        />
        <Route
          path="/brand"
          element={
            <Signed>
              <BrandKitsPage />
            </Signed>
          }
        />
        <Route
          path="/settings"
          element={
            <Signed>
              <SettingsPage />
            </Signed>
          }
        />
        <Route
          path="/inbox"
          element={
            <Signed>
              <InboxPage />
            </Signed>
          }
        />
        <Route
          path="/p/:projectId"
          element={
            <Signed>
              <Workspace />
            </Signed>
          }
        />
        <Route
          path="/p/:projectId/:view"
          element={
            <Signed>
              <Workspace />
            </Signed>
          }
        />
        <Route
          path="*"
          element={
            <Signed>
              <Dashboard />
            </Signed>
          }
        />
      </Routes>
      <Toaster />
    </>
  );
  return (
    <ThemeRoot theme={theme} chrome={chrome} embedded={embedded}>
      {mode === 'memory' ? (
        <MemoryRouter initialEntries={[routing.initialPath ?? '/']}>{routes}</MemoryRouter>
      ) : mode === 'hash' ? (
        <HashRouter>{routes}</HashRouter>
      ) : (
        <BrowserRouter basename={basename}>{routes}</BrowserRouter>
      )}
    </ThemeRoot>
  );
}

/** The standalone studio, under the base the server wrote into the page (docs/design/subpath.md). */
export function App() {
  return <Studio routing={{ mode: 'browser', basename: getRuntime().routerBase }} />;
}
