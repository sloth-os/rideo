import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.RIDEO_API_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, ws: true },
      '/mcp': target,
      '/dav': target,
      '/metrics': target,
    },
  },
  // ffmpeg.wasm starts its worker with new URL('./worker.js', import.meta.url): keep it out of pre-bundling.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  worker: { format: 'es' },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022', chunkSizeWarningLimit: 1500 },
});
