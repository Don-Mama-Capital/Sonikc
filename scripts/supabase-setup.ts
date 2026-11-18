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

// Contrôles de forme, avec des messages qui disent quoi corriger (les valeurs ne sont jamais affichées).
const problems: string[] = [];
if (/\[?YOUR-PASSWORD\]?/i.test(DATABASE_URL)) problems.push('SUPABASE_DB_URL contient encore « [YOUR-PASSWORD] » : remplace-le par le mot de passe de la base (sans crochets).');
let dbHost = '';
try {
  const u = new URL(DATABASE_URL);
  dbHost = u.hostname;
  if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push('SUPABASE_DB_URL doit commencer par postgresql://');
  if (u.hostname.startsWith('db.') && u.hostname.endsWith('.supabase.co')) problems.push('SUPABASE_DB_URL est la connexion directe (db.….supabase.co), inaccessible depuis GitHub : prends la chaîne « Session pooler » (…pooler.supabase.com:5432).');
  if (u.hostname.endsWith('pooler.supabase.com') && u.port === '6543') problems.push('SUPABASE_DB_URL est le « Transaction pooler » (port 6543) : prends le « Session pooler » (port 5432).');
} catch {
  problems.push('SUPABASE_DB_URL n’est pas une adresse valide. Si le mot de passe contient des caractères spéciaux (@ : / ? # %), réinitialise-le avec uniquement des lettres et des chiffres.');
}
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(SUPABASE_URL)) problems.push('SUPABASE_URL doit avoir la forme https://xxxxxxxx.supabase.co (sans rien après).');
if (SECRET.startsWith('sb_publishable_')) problems.push('SUPABASE_SECRET_KEY est la clé publique (sb_publishable_…) : il faut la clé secrète (sb_secret_…).');
else if (!SECRET.startsWith('sb_secret_') && !SECRET.startsWith('eyJ')) problems.push('SUPABASE_SECRET_KEY ne ressemble pas à une clé secrète Supabase (attendu : sb_secret_…).');
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`0/4 secrets bien formés (base : ${dbHost})`);

try {
  await migrate(DATABASE_URL);
} catch (e) {
  const msg = String((e as Error).message ?? e);
  if (/password authentication failed/i.test(msg)) console.error('✗ Mot de passe de la base refusé : vérifie le mot de passe dans SUPABASE_DB_URL (ou réinitialise-le dans Supabase).');
  else if (/tenant or user not found/i.test(msg)) console.error('✗ Utilisateur inconnu du pooler : l’utilisateur doit être « postgres.<référence du projet> », copie la chaîne Session pooler telle quelle.');
  else console.error(`✗ Connexion ou migration impossible : ${msg.slice(0, 300)}`);
  process.exit(1);
}
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
    method: 'POST', headers, // Pas de limite propre au compartiment : il suit la limite globale du projet (50 Mo par fichier en offre gratuite).
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
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
