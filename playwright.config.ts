import { defineConfig, devices } from '@playwright/test';

// Smoke tests against the dev server. The golden capture (scripts/golden-capture.mjs) drives
// legacy/save-viewer.html directly and is not part of this suite.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5173', viewport: { width: 1280, height: 800 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
