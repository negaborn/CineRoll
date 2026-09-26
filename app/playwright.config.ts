import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5183',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // iPhone Safari's engine. Runs the specs whose behaviour differs by engine
    // (canvas features, colour); the rest of the suite stays Chromium-only.
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /(webkit|zz-).*\.spec\.ts/ },
  ],
  webServer: {
    command: 'npm run dev -- --port 5183 --strictPort',
    url: 'http://localhost:5183',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
