-- Lot 2.4 : « Reçus » (un auditeur connecté enregistre un partage) et notifications regroupées avec compteur.
-- On enregistre le lien, pas une copie : l'accès reste décidé à chaque lecture par app.link_grants.

create table saves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  link_id uuid not null references share_links(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, link_id)
);
create index saves_link_idx on saves (link_id);

alter table notifications add column project_id uuid references projects(id) on delete cascade,
  add column link_id uuid references share_links(id) on delete cascade,
  add column count int not null default 1 check (count >= 1),
  -- Auditeurs déjà comptés dans une notification regroupée (compte connecté ou identifiant visiteur) :
  -- le compteur compte des personnes, pas des sessions.
  add column listener_keys text[] not null default '{}';
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('listen', 'download', 'favorite', 'save'));

grant select, delete on saves to sonikc_app;
alter table saves enable row level security;
-- L'auditeur voit et retire ses propres enregistrements ; le producteur voit ceux de ses liens (pour ses stats).
create policy saves_mine on saves for select to sonikc_app using (user_id = app.current_user_id());
create policy saves_owner on saves for select to sonikc_app using (owner_id = app.current_user_id());
create policy saves_delete on saves for delete to sonikc_app using (user_id = app.current_user_id());

-- Enregistrer le partage présenté : compte connecté, accès vérifié, pas le propriétaire.
-- Une seule notification par auditeur et par partage, même après retrait puis nouvel enregistrement.
create or replace function app.save_link() returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := app.current_user_id(); lid uuid := app.current_link(); l record; who text;
begin
  if uid is null then raise exception 'login required'; end if;
  if lid is null or not exists (select 1 from app.link_grants()) then raise exception 'not allowed'; end if;
  select * into l from share_links where id = lid;
  if l.owner_id = uid then return false; end if;
  -- Garde-fou : 200 partages enregistrés par compte au plus.
  if not exists (select 1 from saves where user_id = uid and link_id = lid)
     and (select count(*) from saves where user_id = uid) >= 200 then
    raise exception 'too many saves';
  end if;
  insert into saves (user_id, link_id, owner_id) values (uid, lid, l.owner_id) on conflict do nothing;
  if found and not exists (select 1 from notifications where owner_id = l.owner_id and kind = 'save' and actor_id = uid
                           and project_id is not distinct from l.project_id and track_id is not distinct from l.track_id) then
    who := app.viewer_name(l.track_id);
    insert into notifications (owner_id, kind, project_id, track_id, actor, actor_id, source)
    values (l.owner_id, 'save', l.project_id, l.track_id, who, uid, l.label);
  end if;
  return true;
end $$;
revoke all on function app.save_link() from public;
grant execute on function app.save_link() to sonikc_app;

create or replace function app.listen_start(p_track uuid, p_visitor text) returns table (session_id uuid, tracked boolean, resumed boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := app.current_user_id(); lid uuid := app.current_link(); t record; s uuid; src text; who text; lkey text; nid bigint;
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
           listener_name = coalesce(listener_name, app.viewer_name(p_track)) where id = s;
    return query select s, true, true; return;
  end if;
  -- Garde-fou contre les écoutes fabriquées en masse : 60 nouvelles écoutes par lien et par 10 min au plus.
  if (select count(*) from listen_sessions where link_id = lid and started_at > now() - interval '10 minutes') >= 60 then
    return query select null::uuid, false, false; return;
  end if;
  select label into src from share_links where id = lid;
  who := app.viewer_name(p_track);
  insert into listen_sessions (owner_id, track_id, version_id, link_id, listener_id, listener_name, visitor, source, duration_ms)
  values (t.owner_id, p_track, t.current_version_id, lid, uid, who, p_visitor, src,
          (select duration_ms from track_versions where id = t.current_version_id))
  returning id into s;
  -- Notifications regroupées : une notification non lue par morceau et par lien, mise à jour tant qu'elle
  -- n'est pas lue et que la dernière écoute date de moins de 10 min. Le premier nom affiché est conservé ;
  -- le compteur n'augmente que pour une personne pas encore comptée dans ce groupe.
  lkey := coalesce(uid::text, p_visitor);
  select n.id into nid from notifications n
    where n.owner_id = t.owner_id and n.kind = 'listen' and n.track_id = p_track and n.link_id = lid
      and n.read_at is null and n.created_at > now() - interval '10 minutes'
    order by n.created_at desc limit 1 for update;
  if nid is not null then
    update notifications set created_at = now(), actor = coalesce(actor, who), session_id = s,
           count = case when lkey = any(listener_keys) then count else count + 1 end,
           listener_keys = case when lkey = any(listener_keys) or cardinality(listener_keys) >= 200 then listener_keys else listener_keys || lkey end
      where id = nid;
  else
    insert into notifications (owner_id, kind, track_id, link_id, session_id, actor, source, listener_keys)
    values (t.owner_id, 'listen', p_track, lid, s, who, src, array[lkey]);
  end if;
  return query select s, true, false;
end $$;
