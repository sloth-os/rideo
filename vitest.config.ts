import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server-unit',
          root: './packages/server',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server-integration',
          root: './packages/server',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'mock-gateway',
          root: './packages/mock-gateway',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      './packages/web/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
