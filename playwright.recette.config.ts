import { defineConfig, devices } from '@playwright/test';

// Recette utilisateurs (docs/recette.md) : plusieurs personnages en parallèle sur l'app compilée et le worker réel.
// RECETTE_URL : viser un environnement déjà lancé (sinon scripts/recette-server.ts est démarré).
// RECETTE_ENV=reel : niveau B (Supabase dev + vrai Stripe test) ; seuls les parcours marqués @reel tournent.
const reel = process.env.RECETTE_ENV === 'reel';
const baseURL = process.env.RECETTE_URL ?? 'http://localhost:3200';

export default defineConfig({
  testDir: 'tests/recette',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: Number(process.env.RECETTE_WORKERS ?? 4),
  grep: reel ? /@reel/ : undefined,
  reporter: [['list'], ['json', { outputFile: 'test-results/recette/resultats.json' }], ['html', { outputFolder: 'test-results/recette/html', open: 'never' }]],
  outputDir: 'test-results/recette/traces',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
      args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
    },
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: process.env.RECETTE_URL ? undefined : {
    command: 'npx tsx scripts/recette-server.ts',
    url: `${baseURL}/login`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
