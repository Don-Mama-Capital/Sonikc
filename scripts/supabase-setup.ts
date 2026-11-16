import { Readable } from 'node:stream';
import postgres from 'postgres';
import { migrate } from './migrate';
import { createSupabaseStore } from '../src/lib/server/storage';

/**
 * Prépare le projet Supabase de dev (lancé par GitHub Actions, jamais avec des clés dans le code) :
 * 1. applique les migrations ;
 * 2. vérifie que les rôles exposés par Supabase (anon, authenticated) n'ont accès à rien ;
 * 3. crée le compartiment privé « audio » s'il n'existe pas ;
 * 4. fait un aller-retour de fichier (écriture, lecture signée, suppression).
 */
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} manquant (secret GitHub)`); return v; };
const DATABASE_URL = need('SUPABASE_DB_URL');
const SUPABASE_URL = need('SUPABASE_URL').replace(/\/$/, '');
const SECRET = need('SUPABASE_SECRET_KEY');
const BUCKET = process.env.SUPABASE_BUCKET ?? 'audio';

await migrate(DATABASE_URL);
console.log('1/4 migrations à jour');

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const leaks = await sql<{ role: string; table: string }[]>`
    select r.rolname as role, c.relname as table
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join pg_roles r
    where n.nspname = 'public' and c.relkind = 'r' and r.rolname in ('anon', 'authenticated')
      and (has_table_privilege(r.oid, c.oid, 'select') or has_table_privilege(r.oid, c.oid, 'insert')
        or has_table_privilege(r.oid, c.oid, 'update') or has_table_privilege(r.oid, c.oid, 'delete'))`;
  if (leaks.length) throw new Error(`Accès public ouvert : ${leaks.map((l) => `${l.role} → ${l.table}`).join(', ')}`);
  const noRls = await sql<{ table: string }[]>`
    select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`;
  if (noRls.length) throw new Error(`Tables sans RLS : ${noRls.map((t) => t.table).join(', ')}`);
} finally {
  await sql.end();
}
console.log('2/4 aucune table lisible par anon/authenticated, RLS partout');

const headers = { authorization: `Bearer ${SECRET}`, apikey: SECRET, 'content-type': 'application/json' };
const got = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers });
if (got.status === 200) {
  const b = await got.json();
  if (b.public) throw new Error(`Le compartiment « ${BUCKET} » est public : passe-le en privé dans Supabase.`);
} else {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST', headers, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 600 * 1024 * 1024 }),
  });
  if (!res.ok) throw new Error(`Création du compartiment : HTTP ${res.status} ${await res.text()}`);
}
console.log(`3/4 compartiment privé « ${BUCKET} » prêt`);

const s = createSupabaseStore({ url: SUPABASE_URL, secretKey: SECRET, bucket: BUCKET });
const key = `smoke/${Date.now()}.txt`;
const body = Buffer.from('sonikc smoke test');
await s.put(key, Readable.from(body), 1024, 'text/plain');
if (!(await s.exists(key))) throw new Error('Fichier introuvable après écriture');
const redirect = await s.readResponse(key, new Request('http://x/'), null);
const signed = redirect.headers.get('location');
if (!signed) throw new Error('Pas d’URL signée');
const back = await fetch(signed);
if ((await back.text()) !== body.toString()) throw new Error('Contenu relu différent');
const anon = await fetch(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`);
if (anon.ok) throw new Error('Fichier lisible sans signature');
await s.remove([key]);
if (await s.exists(key)) throw new Error('Fichier toujours présent après suppression');
console.log('4/4 écriture, lecture signée, refus sans signature, suppression : OK');
