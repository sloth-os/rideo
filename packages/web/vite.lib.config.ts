import { posix } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The studio as a library (docs/design/embedding.md#package): `dist-lib/rideo.js` with its chunks and assets,
 * React from the host, the stylesheet as `rideo.css` (scoped to `.rideo-root` by scripts/build-lib.mjs).
 */

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  // Assets load next to the scripts; a host serving them elsewhere sets `assetsBase` (globalThis.__RIDEO_ASSETS__).
  experimental: {
    renderBuiltUrl(filename, { hostId, hostType }) {
      // scripts are imported (the host's bundler follows them); only files loaded by URL are assets
      if (hostType !== 'js' || /\.(m?js|css)$/.test(filename)) return { relative: true };
      const rel = posix.relative(posix.dirname(hostId), filename) || filename;
      return {
        runtime: `(globalThis.__RIDEO_ASSETS__ ? globalThis.__RIDEO_ASSETS__ + ${JSON.stringify(filename)} : new URL(${JSON.stringify(rel)}, import.meta.url).href)`,
      };
    },
  },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  worker: { format: 'es' },
  build: {
    outDir: 'dist-lib',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    cssCodeSplit: false,
    // a host's bundler follows the imports itself; preload lists would only make it copy chunks as assets
    modulePreload: false,
    chunkSizeWarningLimit: 1500,
    assetsInlineLimit: (file: string) => (file.includes('@ffmpeg') ? false : undefined),
    rolldownOptions: {
      input: { rideo: 'src/embed/index.tsx' },
      preserveEntrySignatures: 'exports-only',
      external: (id: string) => /^react(-dom)?(\/|$)/.test(id),
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (asset: { names?: string[] }) =>
          asset.names?.some((n) => n.endsWith('.css')) ? 'rideo.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
