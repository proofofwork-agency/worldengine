import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@worldengine/schema': new URL('./packages/schema/src/index.ts', import.meta.url).pathname,
      '@worldengine/terrain': new URL('./packages/terrain/src/index.ts', import.meta.url).pathname,
      '@worldengine/runtime': new URL('./packages/runtime/src/index.ts', import.meta.url).pathname,
      '@worldengine/compiler': new URL('./packages/compiler/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
});
