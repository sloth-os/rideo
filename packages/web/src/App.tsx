import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Toaster } from './components/Toaster';
import { Dashboard } from './features/dashboard/Dashboard';
import { VerifyPage } from './features/verify/VerifyPage';
import { Workspace } from './features/workspace/Workspace';
import { LiveBridge } from './lib/live-bridge';
import { useUi } from './store/ui';

export function App() {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <BrowserRouter>
      <LiveBridge />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/p/:projectId" element={<Workspace />} />
        <Route path="/p/:projectId/:view" element={<Workspace />} />
        <Route path="*" element={<Dashboard />} />
      </Routes>
      <Toaster />
    </BrowserRouter>
  );
}
