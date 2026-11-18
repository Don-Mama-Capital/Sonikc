-- Lots 2.2 et 2.3 : suivi des écoutes, interactions, notifications.
-- Écrit uniquement par des fonctions du serveur qui revérifient le lien (app.link_grants) ;
-- lu uniquement par le propriétaire (RLS).

create table link_views (
  id bigserial primary key,
  owner_id uuid not null references users(id) on delete cascade,
  link_id uuid not null references share_links(id) on delete cascade,
  visitor text not null,
  listener_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index link_views_link_idx on link_views (link_id, visitor, created_at desc);

create table listen_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  version_id uuid references track_versions(id) on delete set null,
  link_id uuid references share_links(id) on delete set null,
  listener_id uuid references users(id) on delete set null,
  listener_name text,
  visitor text not null,
  source text not null,
  duration_ms int,
  listened_ms int not null default 0 check (listened_ms >= 0),
  started_at timestamptz not null default now(),
  last_beat_at timestamptz not null default now()
);
create index listen_sessions_track_idx on listen_sessions (track_id, started_at desc);
create index listen_sessions_dedupe_idx on listen_sessions (track_id, visitor, link_id, last_beat_at desc);
create index listen_sessions_owner_idx on listen_sessions (owner_id, started_at desc);

create table interactions (
  id bigserial primary key,
  owner_id uuid not null references users(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  link_id uuid references share_links(id) on delete set null,
  listener_id uuid references users(id) on delete set null,
  visitor text not null,
  kind text not null check (kind in ('download', 'favorite')),
  created_at timestamptz not null default now()
);
create unique index interactions_favorite_key on interactions (track_id, listener_id) where kind = 'favorite';
create index interactions_track_idx on interactions (track_id, kind);

create table notifications (
  id bigserial primary key,
  owner_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('listen', 'download', 'favorite')),
  track_id uuid references tracks(id) on delete cascade,
  session_id uuid references listen_sessions(id) on delete cascade,
  actor text,
  source text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_owner_idx on notifications (owner_id, created_at desc);

-- Nom affiché de l'auditeur connecté : son nom d'artiste s'il en a un, sinon son adresse.
create or replace function app.viewer_name() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p.display_name, u.email) from users u left join profiles p on p.user_id = u.id
  where u.id = app.current_user_id()
$$;

create or replace function app.current_link() returns uuid
language sql stable as $$ select nullif(current_setting('app.link_id', true), '')::uuid $$;

-- Ouverture d'une page partagée (une par visiteur et par lien toutes les 30 min).
create or replace function app.record_view(p_visitor text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare lid uuid := app.current_link(); o uuid;
begin
  if lid is null or not exists (select 1 from app.link_grants()) then return false; end if;
  select owner_id into o from share_links where id = lid;
  if o = app.current_user_id() then return false; end if;
  if exists (select 1 from link_views where link_id = lid and visitor = p_visitor and created_at > now() - interval '30 minutes') then return false; end if;
  insert into link_views (owner_id, link_id, visitor, listener_id) values (o, lid, p_visitor, app.current_user_id());
  return true;
end $$;

-- Début d'écoute : reprend la session du même visiteur sur le même morceau et le même lien
-- si elle date de moins de 30 min (un rechargement ne compte pas une deuxième écoute).
create or replace function app.listen_start(p_track uuid, p_visitor text) returns table (session_id uuid, tracked boolean, resumed boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := app.current_user_id(); lid uuid := app.current_link(); t record; s uuid; src text; who text;
begin
  select id, owner_id, current_version_id into t from tracks where id = p_track and deleted_at is null;
  if t.id is null then raise exception 'not allowed'; end if;
  if uid is not null and uid = t.owner_id then return query select null::uuid, false, false; return; end if;
  if lid is null or not exists (select 1 from app.link_grants() g where g.track_id = p_track) then raise exception 'not allowed'; end if;
  select id into s from listen_sessions
    where track_id = p_track and visitor = p_visitor and link_id = lid and last_beat_at > now() - interval '30 minutes'
    order by last_beat_at desc limit 1 for update;
  if s is not null then
    update listen_sessions set last_beat_at = now(), listener_id = coalesce(listener_id, uid),
           listener_name = coalesce(listener_name, app.viewer_name()) where id = s;
    return query select s, true, true; return;
  end if;
  select label into src from share_links where id = lid;
  who := app.viewer_name();
  insert into listen_sessions (owner_id, track_id, version_id, link_id, listener_id, listener_name, visitor, source, duration_ms)
  values (t.owner_id, p_track, t.current_version_id, lid, uid, who, p_visitor, src,
          (select duration_ms from track_versions where id = t.current_version_id))
  returning id into s;
  insert into notifications (owner_id, kind, track_id, session_id, actor, source) values (t.owner_id, 'listen', p_track, s, who, src);
  return query select s, true, false;
end $$;

-- Battement : ajoute le temps réellement joué depuis le dernier battement, plafonné par le temps écoulé
-- (+2 s de marge réseau) : un client ne peut pas annoncer plus que ce qui a pu être écouté.
create or replace function app.listen_beat(p_session uuid, p_visitor text, p_played_ms int) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare lid uuid := app.current_link(); r int;
begin
  update listen_sessions ls set
    listened_ms = least(
      ls.listened_ms + least(greatest(coalesce(p_played_ms, 0), 0),
                             (extract(epoch from (now() - ls.last_beat_at)) * 1000)::int + 2000),
      coalesce(ls.duration_ms, 600000) * 5),
    last_beat_at = now()
  where ls.id = p_session and ls.visitor = p_visitor and ls.link_id = lid
    and ls.last_beat_at > now() - interval '30 minutes'
    and ls.track_id in (select g.track_id from app.link_grants() g)
  returning ls.listened_ms into r;
  return r;
end $$;

-- Interactions : téléchargement (s'il est autorisé) et favori (compte connecté).
create or replace function app.interact(p_track uuid, p_visitor text, p_kind text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := app.current_user_id(); lid uuid := app.current_link(); o uuid; src text; who text;
begin
  if lid is null or not exists (select 1 from app.link_grants() g where g.track_id = p_track) then raise exception 'not allowed'; end if;
  select owner_id into o from tracks where id = p_track;
  if uid is not null and uid = o then return false; end if;
  select label into src from share_links where id = lid;
  who := app.viewer_name();
  if p_kind = 'download' then
    if not exists (
      select 1 from tracks t left join share_links l on l.id = lid left join projects p on p.id = l.project_id
      where t.id = p_track and (t.allow_download or coalesce(p.allow_download, false))) then raise exception 'not allowed'; end if;
    insert into interactions (owner_id, track_id, link_id, listener_id, visitor, kind) values (o, p_track, lid, uid, p_visitor, 'download');
    insert into notifications (owner_id, kind, track_id, actor, source) values (o, 'download', p_track, who, src);
    return true;
  elsif p_kind = 'favorite' then
    if uid is null then raise exception 'login required'; end if;
    insert into interactions (owner_id, track_id, link_id, listener_id, visitor, kind) values (o, p_track, lid, uid, p_visitor, 'favorite')
      on conflict do nothing;
    if found then insert into notifications (owner_id, kind, track_id, actor, source) values (o, 'favorite', p_track, who, src); end if;
    return true;
  elsif p_kind = 'unfavorite' then
    if uid is null then raise exception 'login required'; end if;
    delete from interactions where track_id = p_track and listener_id = uid and kind = 'favorite';
    return false;
  end if;
  raise exception 'unknown kind';
end $$;

-- Favori déjà posé par l'auditeur connecté (pour afficher le cœur plein).
create or replace function app.my_favorites() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select track_id from interactions where kind = 'favorite' and listener_id = app.current_user_id()
    and track_id in (select g.track_id from app.link_grants() g)
$$;

grant execute on function app.record_view(text), app.listen_start(uuid, text), app.listen_beat(uuid, text, int),
  app.interact(uuid, text, text), app.my_favorites(), app.current_link() to sonikc_app;
revoke all on function app.record_view(text), app.listen_start(uuid, text), app.listen_beat(uuid, text, int),
  app.interact(uuid, text, text), app.my_favorites(), app.viewer_name() from public;

grant select on link_views, listen_sessions, interactions, notifications to sonikc_app;
grant update (read_at) on notifications to sonikc_app;
alter table link_views enable row level security;
alter table listen_sessions enable row level security;
alter table interactions enable row level security;
alter table notifications enable row level security;
create policy link_views_owner on link_views for select to sonikc_app using (owner_id = app.current_user_id());
create policy listen_sessions_owner on listen_sessions for select to sonikc_app using (owner_id = app.current_user_id());
create policy interactions_owner on interactions for select to sonikc_app using (owner_id = app.current_user_id());
create policy notifications_owner_read on notifications for select to sonikc_app using (owner_id = app.current_user_id());
create policy notifications_owner_update on notifications for update to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
