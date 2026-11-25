import postgres from 'postgres';

/** Recette réelle, critère B5 : aucun compte de recette laissé actif dans Supabase dev. */
const sql = postgres(process.env.SUPABASE_DB_URL!, { max: 1, prepare: false, onnotice: () => {} });
const rows = await sql<{ email: string }[]>`select email from users where email like 'recette+%@sonikc.test' and deleted_at is null`;
await sql.end();
if (rows.length) {
  console.error(`::error::${rows.length} compte(s) de recette encore actifs : ${rows.map((r) => r.email).join(', ')}`);
  process.exit(1);
}
console.log('Aucun compte de recette laissé actif.');
