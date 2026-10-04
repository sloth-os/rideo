import { defineConfig } from 'vite';

/** The host app of the embedding e2e spec: built like any app that depends on @rideo/web. */
export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  logLevel: 'warn',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
});
