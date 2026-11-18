import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';

// Reproduit ce que Supabase fait par défaut : les rôles anon et authenticated (exposés par l'API REST
// publique) reçoivent automatiquement les droits sur toute nouvelle table. Les migrations doivent les retirer.
describe('Base façon Supabase', () => {
  it('après migration, anon et authenticated ne lisent ni n’écrivent aucune table, et toutes ont la RLS', async () => {
    const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const db = `supa_${Date.now()}`;
    try {
      await admin.unsafe(`create database ${db}`);
      const url = process.env.DATABASE_URL!.replace(/\/[^/]+$/, `/${db}`);
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`
          do $$ begin
            if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
            if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
          end $$;
          grant usage on schema public to anon, authenticated;
          alter default privileges in schema public grant all on tables to anon, authenticated;
          alter default privileges in schema public grant all on sequences to anon, authenticated;
          alter default privileges in schema public grant all on functions to anon, authenticated;`);
        await migrate(url, () => {});
        const leaks = await s`
          select r.rolname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join pg_roles r
          where n.nspname = 'public' and c.relkind = 'r' and r.rolname in ('anon', 'authenticated')
            and (has_table_privilege(r.oid, c.oid, 'select') or has_table_privilege(r.oid, c.oid, 'insert')
              or has_table_privilege(r.oid, c.oid, 'update') or has_table_privilege(r.oid, c.oid, 'delete'))`;
        expect(leaks).toEqual([]);
        const noRls = await s`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`;
        expect(noRls).toEqual([]);
        const [{ ok }] = await s`select has_function_privilege('anon', 'app.enqueue_job(text, uuid)', 'execute') as ok`;
        expect(ok).toBe(false);
        // Fonctions de partage et de suivi : appelables par l'app seule.
        const fns = ['app.link_grants()', 'app.level_ok(text, uuid, uuid)', 'app.viewer_invited(uuid, uuid)', 'app.listen_start(uuid, text)',
          'app.listen_beat(uuid, text, integer)', 'app.interact(uuid, text, text)', 'app.record_view(text)', 'app.viewer_name(uuid)'];
        for (const f of fns) {
          const [{ anon, app }] = await s`select has_function_privilege('anon', ${f}, 'execute') as anon, has_function_privilege('sonikc_app', ${f}, 'execute') as app`;
          expect({ f, anon }).toEqual({ f, anon: false });
          if (f !== 'app.viewer_name(uuid)') expect({ f, app }).toEqual({ f, app: true });
        }
        // Une table créée plus tard n'hérite plus des droits publics.
        await s`create table later_table (id int)`;
        const [{ later }] = await s`select has_table_privilege('anon', 'later_table', 'select') as later`;
        expect(later).toBe(false);
      } finally {
        await s.end();
      }
    } finally {
      await admin.unsafe(`drop database if exists ${db} with (force)`);
      await admin.end();
    }
  });
});
