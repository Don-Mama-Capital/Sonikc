-- Sonikc : schéma initial (phase 1 : compte, bibliothèque, versions, tâches).
-- Règle d'or : l'application se connecte puis passe dans le rôle `sonikc_app`
-- pour chaque requête d'un utilisateur. Ce rôle n'est propriétaire de rien :
-- les politiques RLS s'appliquent toujours à lui. Seuls le worker et les flux
-- d'authentification travaillent sans ce rôle (accès « service »).

create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'sonikc_app') then
    create role sonikc_app nologin;
  end if;
end $$;

create schema if not exists app;
grant usage on schema app to sonikc_app;
grant usage on schema public to sonikc_app;

-- Identifiant de l'utilisateur courant, posé par l'app au début de chaque transaction.
create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;
grant execute on function app.current_user_id() to sonikc_app;

-- ───────────────────────── Comptes ─────────────────────────

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table login_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  ip text,
  created_at timestamptz not null default now()
);
create index login_codes_email_idx on login_codes (lower(email), created_at desc);
create index login_codes_ip_idx on login_codes (ip, created_at desc);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create table profiles (
  user_id uuid primary key references users(id) on delete cascade,
  handle text not null,
  display_name text not null,
  bio text not null default '',
  key_notation text not null default 'sharps' check (key_notation in ('sharps', 'flats')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_handle_format check (handle ~ '^[a-z0-9_.]{3,30}$')
);
create unique index profiles_handle_key on profiles (lower(handle));

-- ───────────────────────── Bibliothèque ─────────────────────────

create table folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  parent_id uuid references folders(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index folders_owner_idx on folders (owner_id, parent_id);

create table projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  folder_id uuid references folders(id) on delete set null,
  title text not null check (length(trim(title)) between 1 and 160),
  pinned boolean not null default false,
  visibility text not null default 'private' check (visibility in ('private', 'invite', 'public', 'for_sale')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index projects_owner_idx on projects (owner_id, folder_id);

create table tracks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  folder_id uuid references folders(id) on delete set null,
  title text not null check (length(trim(title)) between 1 and 160),
  bpm numeric(5, 1) check (bpm is null or (bpm >= 20 and bpm <= 300)),
  bpm_source text not null default 'none' check (bpm_source in ('none', 'detected', 'user')),
  key_pc smallint check (key_pc between 0 and 11),
  key_mode text check (key_mode in ('major', 'minor')),
  key_source text not null default 'none' check (key_source in ('none', 'detected', 'user')),
  tags text[] not null default '{}',
  pinned boolean not null default false,
  visibility text not null default 'private' check (visibility in ('private', 'invite', 'public', 'for_sale')),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint tracks_key_pair check ((key_pc is null) = (key_mode is null))
);
create index tracks_owner_idx on tracks (owner_id, folder_id);
create index tracks_tags_idx on tracks using gin (tags);
create index tracks_title_idx on tracks (owner_id, lower(title));

create table track_versions (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references tracks(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  version_no int not null,
  label text not null,
  status text not null default 'uploading' check (status in ('uploading', 'processing', 'ready', 'failed')),
  error text,
  original_filename text not null,
  original_key text not null,
  size_bytes bigint,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  format text,
  duration_ms int,
  sample_rate int,
  channels smallint,
  preview_key text,
  waveform jsonb,
  bpm_detected numeric(5, 1),
  key_detected_pc smallint,
  key_detected_mode text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (track_id, version_no)
);
create index track_versions_track_idx on track_versions (track_id);

alter table tracks
  add constraint tracks_current_version_fk foreign key (current_version_id)
  references track_versions(id) on delete set null deferrable initially deferred;

create table project_tracks (
  project_id uuid not null references projects(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  position int not null,
  added_at timestamptz not null default now(),
  primary key (project_id, track_id)
);

-- Imports ZIP : un fichier déposé, déballé par le worker.
create table imports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  folder_id uuid references folders(id) on delete set null,
  original_filename text not null,
  original_key text not null,
  status text not null default 'uploading' check (status in ('uploading', 'processing', 'done', 'failed')),
  error text,
  created_folder_id uuid references folders(id) on delete set null,
  tracks_created int not null default 0,
  files_skipped int not null default 0,
  created_at timestamptz not null default now()
);

-- ───────────────────────── Tâches de fond ─────────────────────────

create table jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_queue_idx on jobs (status, run_after) where status = 'queued';

-- ───────────────────────── Droits ─────────────────────────
-- Aucun droit sur users, login_codes, sessions, jobs : accès service uniquement.

grant select, insert, update, delete on profiles, folders, projects, tracks, track_versions, project_tracks, imports to sonikc_app;

alter table profiles enable row level security;
alter table folders enable row level security;
alter table projects enable row level security;
alter table tracks enable row level security;
alter table track_versions enable row level security;
alter table project_tracks enable row level security;
alter table imports enable row level security;

-- Profils : lisibles par tous (page publique), modifiables par leur propriétaire.
create policy profiles_read on profiles for select to sonikc_app using (true);
create policy profiles_insert on profiles for insert to sonikc_app with check (user_id = app.current_user_id());
create policy profiles_update on profiles for update to sonikc_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Phase 1 : tout le contenu est privé, visible et modifiable par son seul propriétaire.
-- La phase 2 ajoutera les politiques de partage (invitation, public, en vente).
create policy folders_owner on folders for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy projects_owner on projects for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy tracks_owner on tracks for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy track_versions_owner on track_versions for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy project_tracks_owner on project_tracks for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy imports_owner on imports for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());

-- Un dossier parent, un projet ou un morceau référencé doit appartenir au même propriétaire.
-- Fonctions en security definer : elles lisent la ligne référencée quel que soit l'utilisateur.
create or replace function app.check_folder() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.parent_id is not null then
    if (select owner_id from folders where id = new.parent_id) is distinct from new.owner_id then
      raise exception 'parent folder belongs to another user';
    end if;
    if exists (
      with recursive up(id, parent_id) as (
        select id, parent_id from folders where id = new.parent_id
        union all
        select f.id, f.parent_id from folders f join up on f.id = up.parent_id
      ) select 1 from up where id = new.id
    ) then raise exception 'folder cycle'; end if;
  end if;
  return new;
end $$;

create or replace function app.check_folder_ref() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.folder_id is not null
     and (select owner_id from folders where id = new.folder_id) is distinct from new.owner_id then
    raise exception 'folder belongs to another user';
  end if;
  return new;
end $$;

-- La version courante d'un morceau doit être une de ses propres versions.
create or replace function app.check_track_current() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.current_version_id is not null
     and (select track_id from track_versions where id = new.current_version_id) is distinct from new.id then
    raise exception 'version belongs to another track';
  end if;
  return new;
end $$;

-- Le dossier créé par un import appartient au même propriétaire.
create or replace function app.check_import_folder() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.created_folder_id is not null
     and (select owner_id from folders where id = new.created_folder_id) is distinct from new.owner_id then
    raise exception 'folder belongs to another user';
  end if;
  return new;
end $$;

create or replace function app.check_version() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select owner_id from tracks where id = new.track_id) is distinct from new.owner_id then
    raise exception 'track belongs to another user';
  end if;
  return new;
end $$;

create or replace function app.check_project_track() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select owner_id from projects where id = new.project_id) is distinct from new.owner_id then
    raise exception 'project belongs to another user';
  end if;
  if (select owner_id from tracks where id = new.track_id) is distinct from new.owner_id then
    raise exception 'track belongs to another user';
  end if;
  return new;
end $$;

create trigger folders_same_owner before insert or update on folders for each row execute function app.check_folder();
create trigger tracks_same_owner before insert or update on tracks for each row execute function app.check_folder_ref();
create trigger projects_same_owner before insert or update on projects for each row execute function app.check_folder_ref();
create trigger imports_same_owner before insert or update on imports for each row execute function app.check_folder_ref();
create trigger imports_created_folder before insert or update on imports for each row execute function app.check_import_folder();
create trigger tracks_current_version before insert or update of current_version_id on tracks for each row execute function app.check_track_current();
create trigger track_versions_same_owner before insert or update on track_versions for each row execute function app.check_version();
create trigger project_tracks_same_owner before insert or update on project_tracks for each row execute function app.check_project_track();

-- updated_at automatique.
create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger profiles_touch before update on profiles for each row execute function app.touch_updated_at();
create trigger folders_touch before update on folders for each row execute function app.touch_updated_at();
create trigger projects_touch before update on projects for each row execute function app.touch_updated_at();
create trigger tracks_touch before update on tracks for each row execute function app.touch_updated_at();

-- Mise en file d'une tâche au nom de l'utilisateur : uniquement pour un objet qui lui appartient.
create or replace function app.enqueue_job(p_kind text, p_target uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := app.current_user_id();
begin
  if uid is null then raise exception 'no user'; end if;
  if p_kind = 'process_version' then
    if not exists (select 1 from track_versions where id = p_target and owner_id = uid and status = 'processing') then
      raise exception 'not allowed';
    end if;
    insert into jobs (kind, payload) values (p_kind, jsonb_build_object('versionId', p_target));
  elsif p_kind = 'unzip_import' then
    if not exists (select 1 from imports where id = p_target and owner_id = uid and status = 'processing') then
      raise exception 'not allowed';
    end if;
    insert into jobs (kind, payload) values (p_kind, jsonb_build_object('importId', p_target));
  else
    raise exception 'unknown job kind';
  end if;
end $$;
revoke all on function app.enqueue_job(text, uuid) from public;
grant execute on function app.enqueue_job(text, uuid) to sonikc_app;
