import { create } from 'zustand';

/** The installable app's state in this tab (docs/design/pwa.md#the-app-shell). */
interface PwaState {
  /** The browser offers to install the app (`beforeinstallprompt`). */
  installable: boolean;
  /** Running as the installed app (standalone display). */
  standalone: boolean;
  /** iOS Safari installs only from Share → Add to Home Screen. */
  ios: boolean;
  offline: boolean;
  /** Shows the browser's install dialog. */
  install: (() => Promise<void>) | null;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const standalone = () =>
  globalThis.matchMedia?.('(display-mode: standalone)').matches ||
  (globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined)?.standalone === true;

export const usePwa = create<PwaState>(() => ({
  installable: false,
  standalone: !!standalone(),
  ios: /iPhone|iPad|iPod/.test(globalThis.navigator?.userAgent ?? ''),
  offline: globalThis.navigator ? !globalThis.navigator.onLine : false,
  install: null,
}));

/** Registers the service worker (production builds) and follows the install prompt and the connection. */
export function startPwa(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    const event = e as InstallPromptEvent;
    usePwa.setState({
      installable: true,
      install: async () => {
        await event.prompt();
        const { outcome } = await event.userChoice;
        if (outcome === 'accepted') usePwa.setState({ installable: false, install: null });
      },
    });
  });
  window.addEventListener('appinstalled', () => usePwa.setState({ installable: false, install: null }));
  window.addEventListener('online', () => usePwa.setState({ offline: false }));
  window.addEventListener('offline', () => usePwa.setState({ offline: true }));
  if (import.meta.env.PROD && 'serviceWorker' in navigator)
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('service worker not registered', err);
    });
}
