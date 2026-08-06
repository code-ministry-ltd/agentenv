import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: 'ui-*.e2e.test.ts',
  outputDir: 'test-results/ui',
  globalSetup: './test/ui-global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:41739',
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
