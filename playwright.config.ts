import { defineConfig, devices } from '@playwright/test';

// Recette dans un vrai Chrome. Le navigateur du système est utilisé (pas de téléchargement).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
      args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: 'npx tsx scripts/e2e-server.ts',
    url: 'http://localhost:3100/login',
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
