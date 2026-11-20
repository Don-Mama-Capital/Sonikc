-- Lots 4.1 et 4.2 : page publique du producteur, modèles de licence, morceaux en vente.

-- Profil public : réseaux.
alter table profiles add column links jsonb not null default '{}'::jsonb
  check (jsonb_typeof(links) = 'object' and octet_length(links::text) <= 2000);

-- Modèles de licence du producteur. Prix hors taxes, en centimes d'euro.
create table licence_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  description text not null default '' check (length(description) <= 1000),
  formats text[] not null check (cardinality(formats) between 1 and 3 and formats <@ array['mp3', 'wav', 'stems']),
  max_streams int check (max_streams > 0),          -- null = illimité
  max_copies int check (max_copies > 0),            -- null = illimité
  music_videos int check (music_videos >= 0),       -- null = illimité
  radio boolean not null default false,
  exclusive boolean not null default false,
  price_cents int not null check (price_cents between 100 and 10000000),
  active boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index licence_templates_owner_idx on licence_templates (owner_id, position);

-- Réglage par morceau : licence désactivée ou prix différent pour ce morceau.
create table track_licences (
  track_id uuid not null references tracks(id) on delete cascade,
  template_id uuid not null references licence_templates(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  enabled boolean not null default true,
  price_cents int check (price_cents between 100 and 10000000),
  primary key (track_id, template_id)
);

-- Exclusivité : vendue (définitif) ou réservée le temps d'un paiement.
alter table tracks add column exclusive_sold_at timestamptz,
  add column exclusive_reserved_until timestamptz,
  add column exclusive_reserved_order uuid;

create or replace function app.check_track_licence_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select owner_id from tracks where id = new.track_id) is distinct from new.owner_id
     or (select owner_id from licence_templates where id = new.template_id) is distinct from new.owner_id then
    raise exception 'track or licence belongs to another user';
  end if;
  return new;
end $$;
revoke all on function app.check_track_licence_owner() from public;
create trigger track_licences_owner before insert or update on track_licences for each row execute function app.check_track_licence_owner();

-- L'exclusivité ne se modifie pas par l'app (seul le paiement, côté serveur, la pose).
revoke update on tracks from sonikc_app;
grant update (folder_id, title, bpm, bpm_source, key_pc, key_mode, key_source, tags, pinned, current_version_id, deleted_at, visibility,
              password_hash, allow_download, updated_at) on tracks to sonikc_app;

grant select, insert, update, delete on licence_templates, track_licences to sonikc_app;
alter table licence_templates enable row level security;
alter table track_licences enable row level security;
create policy licence_templates_owner on licence_templates for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy track_licences_owner on track_licences for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());

-- ───────── Catalogue public ─────────
-- Lecture publique seulement quand le serveur pose app.public_catalog (pages publiques) :
-- dans la bibliothèque d'un producteur, les morceaux publics des autres n'apparaissent jamais.
create or replace function app.in_public_catalog() returns boolean
language sql stable as $$ select coalesce(current_setting('app.public_catalog', true), '') = '1' $$;

create policy projects_public on projects for select to sonikc_app
  using (app.in_public_catalog() and deleted_at is null and visibility in ('public', 'for_sale') and password_hash is null);
-- Un morceau est public s'il l'est lui-même, ou s'il « suit » un projet public qui le contient.
create policy tracks_public on tracks for select to sonikc_app
  using (app.in_public_catalog() and deleted_at is null and password_hash is null and current_version_id is not null
         and (visibility in ('public', 'for_sale')
              or (visibility is null and exists (
                    select 1 from project_tracks pt join projects p on p.id = pt.project_id
                    where pt.track_id = tracks.id and p.deleted_at is null and p.password_hash is null and p.visibility in ('public', 'for_sale')))));
-- Appartenances visibles seulement pour les projets publics (sous-requête soumise à la RLS des projets).
create policy project_tracks_public on project_tracks for select to sonikc_app
  using (app.in_public_catalog() and exists (select 1 from projects p where p.id = project_id));
create policy track_versions_public on track_versions for select to sonikc_app
  using (app.in_public_catalog() and id in (select t.current_version_id from tracks t)); -- tracks filtré par sa propre RLS
create policy licence_templates_public on licence_templates for select to sonikc_app
  using (app.in_public_catalog() and active);
create policy track_licences_public on track_licences for select to sonikc_app
  using (app.in_public_catalog() and exists (select 1 from tracks t where t.id = track_id));

-- Offre du producteur (la phase 5 la gère par abonnement) : jamais modifiable par l'app directement.
alter table profiles add column plan text not null default 'free' check (plan in ('free', 'pro', 'studio'));
revoke update on profiles from sonikc_app;
grant update (display_name, bio, key_notation, links, updated_at) on profiles to sonikc_app;
