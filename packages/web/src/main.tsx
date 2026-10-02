import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startPwa } from './pwa/register';
import './styles/index.css';

// The installable app: service worker, install prompt (docs/design/pwa.md)
startPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
