-- Lot 2.1 : partage. Niveaux d'accès, liens de partage, invitations, mot de passe, téléchargement.
-- Un auditeur passe par le rôle sonikc_app comme tout le monde ; ce qu'il peut lire est décidé
-- par la base (app.link_grants), à partir du lien présenté (app.link_id) et du compte connecté.

alter table projects add column password_hash text, add column allow_download boolean not null default false;
alter table tracks add column password_hash text, add column allow_download boolean not null default false;
-- Un morceau sans réglage propre (null) suit le projet dans lequel il est partagé ; seul, il reste privé.
-- « Privé » explicite le cache partout, même dans un projet partagé. Aucun morceau n'avait de réglage en phase 1.
alter table tracks alter column visibility drop not null, alter column visibility set default null;
update tracks set visibility = null where visibility = 'private';

create table share_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  track_id uuid references tracks(id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 60),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint share_links_one_target check ((project_id is null) <> (track_id is null))
);
create index share_links_project_idx on share_links (project_id) where project_id is not null;
create index share_links_track_idx on share_links (track_id) where track_id is not null;

create table invites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  track_id uuid references tracks(id) on delete cascade,
  email text not null check (email ~ '^[^@\s]+@[^@\s]+$'),
  link_id uuid references share_links(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint invites_one_target check ((project_id is null) <> (track_id is null))
);
create unique index invites_active_key on invites (coalesce(project_id, track_id), lower(email)) where revoked_at is null;

-- Tentatives de mot de passe (limite de débit), écrites par le flux d'authentification uniquement.
create table unlock_attempts (
  id bigserial primary key,
  link_id uuid not null references share_links(id) on delete cascade,
  visitor text not null,
  created_at timestamptz not null default now()
);
create index unlock_attempts_idx on unlock_attempts (link_id, created_at desc);

-- Même propriétaire que la cible.
create or replace function app.check_share_target() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.project_id is not null and (select owner_id from projects where id = new.project_id) is distinct from new.owner_id then
    raise exception 'project belongs to another user';
  end if;
  if new.track_id is not null and (select owner_id from tracks where id = new.track_id) is distinct from new.owner_id then
    raise exception 'track belongs to another user';
  end if;
  return new;
end $$;
create trigger share_links_same_owner before insert or update on share_links for each row execute function app.check_share_target();
create trigger invites_same_owner before insert or update on invites for each row execute function app.check_share_target();

-- L'auditeur connecté est-il invité sur ce projet ou ce morceau ?
create or replace function app.viewer_invited(p_project uuid, p_track uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.current_user_id() is not null and exists (
    select 1 from invites i join users u on u.id = app.current_user_id()
    where i.revoked_at is null and lower(i.email) = lower(u.email)
      and ((p_project is not null and i.project_id = p_project) or (p_track is not null and i.track_id = p_track)))
$$;

create or replace function app.level_ok(p_visibility text, p_project uuid, p_track uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_visibility
    when 'invite' then app.viewer_invited(p_project, p_track)
    when 'public' then true
    when 'for_sale' then true
    else false end
$$;

-- Ce que le lien présenté donne à lire : le projet (track_id null), ses morceaux autorisés, ou un morceau seul.
-- Dans un projet, un morceau garde son propre réglage : sans réglage, il suit le projet ;
-- privé ou protégé par son propre mot de passe = absent.
create or replace function app.link_grants() returns table (project_id uuid, track_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  with l as (
    select * from share_links
    where id = nullif(current_setting('app.link_id', true), '')::uuid and revoked_at is null
  ),
  u as (select coalesce(current_setting('app.link_unlocked', true), '') = '1' as unlocked),
  p as (
    select pr.id from projects pr join l on pr.id = l.project_id cross join u
    where pr.deleted_at is null and pr.owner_id = l.owner_id
      and app.level_ok(pr.visibility, pr.id, null) and (pr.password_hash is null or u.unlocked)
  ),
  pt as (
    select p.id as project_id, t.id as track_id
    from p join project_tracks x on x.project_id = p.id join tracks t on t.id = x.track_id
    where t.deleted_at is null and t.password_hash is null and t.current_version_id is not null
      and (t.visibility is null or app.level_ok(t.visibility, p.id, t.id))
  ),
  st as (
    select t.id from tracks t join l on t.id = l.track_id cross join u
    where t.deleted_at is null and t.owner_id = l.owner_id
      and app.level_ok(t.visibility, null, t.id) and (t.password_hash is null or u.unlocked)
  )
  select id, null::uuid from p
  union all select project_id, track_id from pt
  union all select null::uuid, id from st
$$;
grant execute on function app.link_grants() to sonikc_app;

grant select, insert, update, delete on share_links, invites to sonikc_app;
alter table share_links enable row level security;
alter table invites enable row level security;
alter table unlock_attempts enable row level security; -- aucun droit pour sonikc_app : accès service seulement
create policy share_links_owner on share_links for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy invites_owner on invites for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());

-- Lecture par un auditeur : uniquement ce que le lien accorde. Aucune écriture.
create policy projects_shared on projects for select to sonikc_app
  using (id in (select g.project_id from app.link_grants() g where g.track_id is null));
create policy tracks_shared on tracks for select to sonikc_app
  using (id in (select g.track_id from app.link_grants() g where g.track_id is not null));
create policy project_tracks_shared on project_tracks for select to sonikc_app
  using ((project_id, track_id) in (select g.project_id, g.track_id from app.link_grants() g where g.project_id is not null and g.track_id is not null));
-- Seule la version courante d'un morceau accordé est lisible par un tiers.
create policy track_versions_shared on track_versions for select to sonikc_app
  using (id in (select t.current_version_id from tracks t where t.id in (select g.track_id from app.link_grants() g where g.track_id is not null)));
