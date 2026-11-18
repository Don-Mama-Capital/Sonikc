import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { startPostgres } from '../../scripts/pg';
import { migrate } from '../../scripts/migrate';

// Un Postgres jetable par lancement de tests, schéma appliqué depuis les vraies migrations.
export default async function setup(project: TestProject) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sonikc-test-'));
  const port = 55000 + Math.floor(Math.random() * 2000);
  const pg = await startPostgres({ dir: path.join(dir, 'pg'), port, persistent: false });
  await migrate(pg.url, () => {});
  project.provide('databaseUrl', pg.url);
  project.provide('dataDir', dir);
  return async () => {
    await pg.stop();
    await rm(dir, { recursive: true, force: true });
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    dataDir: string;
  }
}
