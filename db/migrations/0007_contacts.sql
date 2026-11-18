-- Lot 3.1 : contacts, groupes (manuels ou à règle), rattachement automatique des écoutes aux contacts.

create table contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  name text check (name is null or length(name) <= 120),
  tags text[] not null default '{}' check (cardinality(tags) <= 30),
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, email)
);
create index contacts_owner_idx on contacts (owner_id, created_at desc);
create index contacts_tags_idx on contacts using gin (tags);

create table contact_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  -- null = groupe manuel ; sinon règle évaluée à chaque lecture (toujours à jour).
  rule jsonb check (rule is null or rule->>'type' in ('listened_over', 'tag', 'score_min', 'inactive')),
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table contact_group_members (
  group_id uuid not null references contact_groups(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  primary key (group_id, contact_id)
);

-- Liens personnels (emailing, lot 3.2) et rattachement des activités à un contact.
alter table share_links add column contact_id uuid references contacts(id) on delete set null;
alter table listen_sessions add column contact_id uuid references contacts(id) on delete set null;
alter table interactions add column contact_id uuid references contacts(id) on delete set null;
alter table saves add column contact_id uuid references contacts(id) on delete set null;
create index listen_sessions_contact_idx on listen_sessions (contact_id, started_at desc) where contact_id is not null;
create index interactions_contact_idx on interactions (contact_id) where contact_id is not null;
create index saves_contact_idx on saves (contact_id) where contact_id is not null;

-- Contact concerné par une activité : celui du lien personnel, sinon le contact du producteur
-- qui a la même adresse que le compte connecté. Rien pour un visiteur anonyme sur un lien public.
create or replace function app.contact_for(p_owner uuid, p_link uuid, p_user uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select l.contact_id from share_links l join contacts c on c.id = l.contact_id and c.owner_id = p_owner where l.id = p_link),
    (select c.id from contacts c join users u on lower(u.email) = c.email where c.owner_id = p_owner and u.id = p_user))
$$;

-- Une fonction par forme de table (PL/pgSQL résout tous les champs d'une expression, même hors branche).
create or replace function app.set_activity_contact() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.contact_id is null then new.contact_id := app.contact_for(new.owner_id, new.link_id, new.listener_id); end if;
  return new;
end $$;
create or replace function app.set_save_contact() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.contact_id is null then new.contact_id := app.contact_for(new.owner_id, new.link_id, new.user_id); end if;
  return new;
end $$;
create trigger listen_sessions_contact before insert on listen_sessions for each row execute function app.set_activity_contact();
create trigger interactions_contact before insert on interactions for each row execute function app.set_activity_contact();
create trigger saves_contact before insert on saves for each row execute function app.set_save_contact();

-- Même propriétaire pour un membre de groupe et pour le contact d'un lien.
create or replace function app.check_member_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select owner_id from contact_groups where id = new.group_id) is distinct from new.owner_id
     or (select owner_id from contacts where id = new.contact_id) is distinct from new.owner_id then
    raise exception 'group or contact belongs to another user';
  end if;
  return new;
end $$;
create or replace function app.check_link_contact_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.contact_id is not null and (select owner_id from contacts where id = new.contact_id) is distinct from new.owner_id then
    raise exception 'contact belongs to another user';
  end if;
  return new;
end $$;
create trigger contact_group_members_owner before insert or update on contact_group_members for each row execute function app.check_member_owner();
create trigger share_links_contact_owner before insert or update of contact_id on share_links for each row execute function app.check_link_contact_owner();

revoke all on function app.contact_for(uuid, uuid, uuid), app.set_activity_contact(), app.set_save_contact(),
  app.check_member_owner(), app.check_link_contact_owner() from public;

grant select, insert, update, delete on contacts, contact_groups, contact_group_members to sonikc_app;
alter table contacts enable row level security;
alter table contact_groups enable row level security;
alter table contact_group_members enable row level security;
create policy contacts_owner on contacts for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy contact_groups_owner on contact_groups for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy contact_group_members_owner on contact_group_members for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());

-- Activité par contact sur 90 jours, calculée à la lecture (vue « security_invoker » : la RLS s'applique).
-- Points : écoute > 30 s = 1, écoute complète = 3, téléchargement ou enregistrement = 5 (clics : lot 3.2).
create view contact_activity with (security_invoker = true) as
select c.id as contact_id, c.owner_id,
  coalesce(s.points, 0) + 5 * coalesce(i.downloads, 0) + 5 * coalesce(v.saves, 0) as score,
  coalesce(s.plays, 0) as plays,
  coalesce(s.max_ms, 0) as max_listened_ms,
  greatest(s.last_at, i.last_at, v.last_at) as last_activity_at
from contacts c
left join lateral (
  select count(*)::int as plays, max(listened_ms) as max_ms, max(last_beat_at) as last_at,
         sum(case when duration_ms > 0 and listened_ms >= duration_ms * 0.8 then 3 when listened_ms >= 30000 then 1 else 0 end)
           filter (where started_at > now() - interval '90 days')::int as points
  from listen_sessions where contact_id = c.id) s on true
left join lateral (
  select count(*) filter (where kind = 'download' and created_at > now() - interval '90 days')::int as downloads, max(created_at) as last_at
  from interactions where contact_id = c.id) i on true
left join lateral (
  select count(*) filter (where created_at > now() - interval '90 days')::int as saves, max(created_at) as last_at
  from saves where contact_id = c.id) v on true;
grant select on contact_activity to sonikc_app;
