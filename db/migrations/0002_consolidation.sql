-- Lot 1.5 : écriture usuelle des tonalités par défaut, et durcissement pour Supabase.

-- 1. Notation des tonalités : « auto » = écriture usuelle (Eb maj, F# min, Bb maj…).
alter table profiles drop constraint if exists profiles_key_notation_check;
alter table profiles add constraint profiles_key_notation_check check (key_notation in ('auto', 'sharps', 'flats'));
alter table profiles alter column key_notation set default 'auto';
update profiles set key_notation = 'auto' where key_notation = 'sharps';

-- 2. L'utilisateur qui applique les migrations doit pouvoir endosser le rôle applicatif.
--    (Sur Supabase, « postgres » n'est pas superutilisateur : sans ce droit, SET ROLE échoue.)
do $$ begin
  execute format('grant sonikc_app to %I', current_user);
exception when others then null;
end $$;

-- 3. RLS partout : une table sans politique est fermée à tout rôle non propriétaire.
alter table users enable row level security;
alter table login_codes enable row level security;
alter table sessions enable row level security;
alter table jobs enable row level security;
alter table schema_migrations enable row level security;

-- 4. Supabase expose le schéma public via son API REST aux rôles anon et authenticated.
--    Sonikc n'utilise pas cette API : on leur retire tout droit, présent et futur.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke usage on schema app from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
