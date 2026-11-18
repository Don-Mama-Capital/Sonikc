import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

/** Applique dans l'ordre les migrations de db/migrations pas encore appliquées. */
export async function migrate(databaseUrl: string, log = console.log) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const dir = path.resolve(import.meta.dirname, '../db/migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(path.join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${file})`;
      });
      log(`migration appliquée : ${file}`);
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');
  await migrate(url);
}
