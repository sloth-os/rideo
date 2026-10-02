import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Toaster } from './components/Toaster';
import { Spinner } from './components/ui';
import { AdminPage } from './features/account/AdminPage';
import { BrandKitsPage } from './features/account/BrandKitsPage';
import { LoginPage } from './features/account/LoginPage';
import { TokensPage } from './features/account/TokensPage';
import { Dashboard } from './features/dashboard/Dashboard';
import { InboxPage } from './features/inbox/InboxPage';
import { GuestReviewPage } from './features/review/GuestReviewPage';
import { VerifyPage } from './features/verify/VerifyPage';
import { Workspace } from './features/workspace/Workspace';
import { loginUrl, useAuth } from './lib/auth';
import { LiveBridge } from './lib/live-bridge';
import { useUi } from './store/ui';

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

export function App() {
  const theme = useUi((s) => s.theme);
  const load = useAuth((s) => s.load);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <BrowserRouter>
      <Live />
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
    </BrowserRouter>
  );
}
