import { useEffect, useState } from 'react';
import { api, type PublicConfig } from './api';

let cached: Promise<PublicConfig> | null = null;

/** Public server config (brand, features, model catalogue), fetched once per page. */
export function useConfig(): PublicConfig | null {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  useEffect(() => {
    cached ??= api.config().catch((err) => {
      cached = null;
      throw err;
    });
    cached.then(setCfg).catch(() => undefined);
  }, []);
  return cfg;
}
