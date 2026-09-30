import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    name: 'web',
    root: import.meta.dirname,
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
