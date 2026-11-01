import { defineConfig } from 'vitest/config';

// Unit tests run in Node. Worker contract/integration tests run in workerd via
// apps/worker/vitest.config.ts (real local D1/R2/Queues through Miniflare).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
