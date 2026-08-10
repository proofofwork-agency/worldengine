import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/editor/e2e',
  use: { baseURL: 'http://127.0.0.1:4174' },
  webServer: [
    {
      command: 'pnpm --filter @worldengine/compiler-service build && WORLDENGINE_DATA_DIR=.tmp/playwright-compiler PORT=8788 pnpm --filter @worldengine/compiler-service start',
      port: 8788,
      reuseExistingServer: true,
    },
    {
      command: 'VITE_COMPILER_URL=http://127.0.0.1:8788 VITE_E2E_MODE=true pnpm --filter @worldengine/editor build && pnpm --filter @worldengine/editor preview --host 127.0.0.1 --port 4174',
      port: 4174,
      reuseExistingServer: true,
    },
  ],
});
