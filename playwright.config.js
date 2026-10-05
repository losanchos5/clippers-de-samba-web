import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:8788' },
  webServer: {
    command: 'npx wrangler dev --port 8788 --ip 127.0.0.1',
    url: 'http://127.0.0.1:8788',
    reuseExistingServer: true,
    timeout: 90_000,
    env: { WRANGLER_SEND_METRICS: 'false' },
  },
  projects: [
    { name: 'movil', use: { ...devices['Pixel 7'] } },
    { name: 'escritorio', use: { viewport: { width: 1280, height: 800 } } },
  ],
});
