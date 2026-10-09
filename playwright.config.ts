import { defineConfig, devices } from '@playwright/test';

// Smoke tests against the dev server. The golden capture (scripts/golden-capture.mjs) drives
// legacy/save-viewer.html directly and is not part of this suite.
// PW_PORT runs the suite against a dev server on another port (e.g. a second worktree).
const PORT = Number(process.env.PW_PORT ?? 5173);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1280, height: 800 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: { command: `npx vite --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
