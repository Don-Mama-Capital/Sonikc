import { defineConfig } from 'vitest/config';
import path from 'node:path';

/** Test réel contre Stripe en mode test (GitHub, avec le secret STRIPE_TEST_SECRET_KEY). */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['tests/live/**/*.test.ts'],
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/env.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
