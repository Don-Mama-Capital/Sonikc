import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/** Démarre un Postgres 17 embarqué (développement et tests uniquement). */
export async function startPostgres(opts: { dir: string; port: number; persistent: boolean }) {
  const dir = path.resolve(opts.dir);
  await mkdir(path.dirname(dir), { recursive: true });
  // Postgres refuse de tourner en root : le paquet crée un utilisateur dédié qui doit pouvoir écrire ici.
  await chmod(path.dirname(dir), 0o777).catch(() => {});
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: opts.port,
    persistent: opts.persistent,
    onLog: () => {},
  });
  const { existsSync } = await import('node:fs');
  if (!existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase('sonikc');
  } catch {
    /* déjà créée */
  }
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${opts.port}/sonikc`,
    stop: () => pg.stop(),
  };
}
