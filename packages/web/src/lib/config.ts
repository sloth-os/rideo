import { useEffect } from 'react';
import { create } from 'zustand';
import { api, type PublicConfig } from './api';

/**
 * Public server config (brand, features, theme, model catalogue): fetched once per page and again after a settings
 * change (docs/design/settings.md#applying-a-change), so features that appear or go away show at once.
 */
interface ConfigState {
  config: PublicConfig | null;
  loading: Promise<PublicConfig> | null;
  load(): Promise<PublicConfig>;
  reload(): Promise<PublicConfig>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  loading: null,
  load() {
    const { config, loading } = get();
    if (config) return Promise.resolve(config);
    if (loading) return loading;
    const p = api
      .config()
      .then((c) => {
        set({ config: c, loading: null });
        return c;
      })
      .catch((err) => {
        set({ loading: null });
        throw err;
      });
    set({ loading: p });
    return p;
  },
  reload() {
    set({ config: null, loading: null });
    return get().load();
  },
}));

export function useConfig(): PublicConfig | null {
  const config = useConfigStore((s) => s.config);
  const load = useConfigStore((s) => s.load);
  useEffect(() => {
    if (!config) load().catch(() => undefined);
  }, [config, load]);
  return config;
}

/** Whether AI features are on (mm-gateway is configured); null until the config arrives. */
export function useAi(): boolean | null {
  const config = useConfig();
  return config ? config.features.gateway !== false : null;
}
