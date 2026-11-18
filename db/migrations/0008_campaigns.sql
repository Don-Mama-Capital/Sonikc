-- Lots 3.2 et 3.3 : envois d'emails (campagnes), suivi des ouvertures et clics, désinscription,
-- programmation et relances. L'envoi est fait par le worker ; les liens publics (ouverture, clic,
-- désinscription) passent par des fonctions de la base, après vérification de leur signature.

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  track_id uuid references tracks(id) on delete cascade,
  subject text not null check (length(trim(subject)) between 1 and 150),
  body text not null check (length(trim(body)) between 1 and 5000),
  status text not null default 'scheduled' check (status in ('scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  followup_days int check (followup_days between 1 and 60),
  followup_subject text check (followup_subject is null or length(trim(followup_subject)) between 1 and 150),
  followup_body text check (followup_body is null or length(trim(followup_body)) between 1 and 5000),
  followup_status text check (followup_status in ('scheduled', 'sent', 'cancelled')),
  created_at timestamptz not null default now(),
  constraint campaigns_one_target check ((project_id is null) <> (track_id is null)),
  constraint campaigns_followup_complete check ((followup_days is null) = (followup_status is null))
);
create index campaigns_owner_idx on campaigns (owner_id, created_at desc);

create table email_sends (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  email text not null,
  step int not null default 0 check (step in (0, 1)),
  link_id uuid references share_links(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  skip_reason text,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  error text,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (campaign_id, email, step)
);
create index email_sends_queue_idx on email_sends (campaign_id, status, next_attempt_at);
create index email_sends_sent_day_idx on email_sends (sent_at) where status = 'sent';
create index email_sends_contact_idx on email_sends (contact_id) where contact_id is not null;

create or replace function app.check_campaign_target() returns trigger
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
create trigger campaigns_same_owner before insert or update on campaigns for each row execute function app.check_campaign_target();

-- Un envoi appartient au propriétaire de la campagne, du contact et du lien personnel (qui doit être celui du contact).
create or replace function app.check_send_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select owner_id from campaigns where id = new.campaign_id) is distinct from new.owner_id
     or (new.contact_id is not null and (select owner_id from contacts where id = new.contact_id) is distinct from new.owner_id)
     or (new.link_id is not null and not exists (
           select 1 from share_links l where l.id = new.link_id and l.owner_id = new.owner_id and l.contact_id is not distinct from new.contact_id)) then
    raise exception 'send belongs to another user';
  end if;
  return new;
end $$;
revoke all on function app.check_send_owner() from public;
create trigger email_sends_same_owner before insert on email_sends for each row execute function app.check_send_owner();

-- Le producteur gère ses campagnes ; il lit ses envois et ne peut y changer que « a répondu ».
grant select, insert, update, delete on campaigns to sonikc_app;
grant select on email_sends to sonikc_app;
-- Création des envois par le producteur : seulement ces colonnes (statut, dates, essais restent au worker).
grant insert (owner_id, campaign_id, contact_id, email, step, link_id) on email_sends to sonikc_app;
grant update (replied_at) on email_sends to sonikc_app;
alter table campaigns enable row level security;
alter table email_sends enable row level security;
create policy campaigns_owner on campaigns for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy email_sends_owner_read on email_sends for select to sonikc_app using (owner_id = app.current_user_id());
create policy email_sends_owner_insert on email_sends for insert to sonikc_app
  with check (owner_id = app.current_user_id() and step = 0);
create policy email_sends_owner_reply on email_sends for update to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());

-- Événements venus des liens d'un email (jeton signé vérifié par le serveur avant l'appel).
-- Une ouverture et un clic comptent une fois par envoi ; la désinscription vaut pour tous les envois du producteur.
create or replace function app.email_event(p_send uuid, p_kind text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record;
begin
  select * into s from email_sends where id = p_send;
  if s.id is null then return null; end if;
  if p_kind = 'open' then
    update email_sends set opened_at = coalesce(opened_at, now()) where id = p_send;
  elsif p_kind = 'click' then
    update email_sends set clicked_at = coalesce(clicked_at, now()), opened_at = coalesce(opened_at, now()) where id = p_send;
  elsif p_kind = 'unsubscribe' then
    update contacts set unsubscribed_at = coalesce(unsubscribed_at, now()) where owner_id = s.owner_id and email = lower(s.email);
    -- Plus rien ne part à cette adresse pour ce producteur, y compris ce qui est en file.
    update email_sends set status = 'skipped', skip_reason = 'unsubscribed'
      where owner_id = s.owner_id and lower(email) = lower(s.email) and status = 'queued';
  else
    raise exception 'unknown kind';
  end if;
  return s.link_id;
end $$;
revoke all on function app.email_event(uuid, text), app.check_campaign_target() from public;
grant execute on function app.email_event(uuid, text) to sonikc_app;

-- Le score d'activité compte aussi les clics dans les emails (1 point, 90 jours).
create or replace view contact_activity with (security_invoker = true) as
select c.id as contact_id, c.owner_id,
  coalesce(s.points, 0) + 5 * coalesce(i.downloads, 0) + 5 * coalesce(v.saves, 0) + coalesce(e.clicks, 0) as score,
  coalesce(s.plays, 0) as plays,
  coalesce(s.max_ms, 0) as max_listened_ms,
  greatest(s.last_at, i.last_at, v.last_at, e.last_at) as last_activity_at
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
  from saves where contact_id = c.id) v on true
left join lateral (
  select count(*) filter (where clicked_at > now() - interval '90 days')::int as clicks, max(clicked_at) as last_at
  from email_sends where contact_id = c.id and clicked_at is not null) e on true;

-- Mise en file d'un envoi par son propriétaire, à l'heure programmée.
create or replace function app.enqueue_campaign(p_campaign uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record;
begin
  select * into c from campaigns where id = p_campaign and owner_id = app.current_user_id() and status = 'scheduled';
  if c.id is null then raise exception 'not allowed'; end if;
  insert into jobs (kind, payload, run_after, max_attempts)
  values ('campaign_send', jsonb_build_object('campaignId', c.id, 'step', 0), c.scheduled_at, 5);
end $$;
revoke all on function app.enqueue_campaign(uuid) from public;
grant execute on function app.enqueue_campaign(uuid) to sonikc_app;

-- Annulation par le propriétaire : la campagne et tout ce qui n'est pas encore parti.
create or replace function app.cancel_campaign(p_campaign uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update campaigns set status = 'cancelled',
         followup_status = case when followup_status = 'scheduled' then 'cancelled' else followup_status end
    where id = p_campaign and owner_id = app.current_user_id() and status in ('scheduled', 'sending');
  if not found then return false; end if;
  update email_sends set status = 'skipped', skip_reason = 'cancelled' where campaign_id = p_campaign and status = 'queued';
  return true;
end $$;
revoke all on function app.cancel_campaign(uuid) from public;
grant execute on function app.cancel_campaign(uuid) to sonikc_app;

-- Une écoute anonyme par un lien personnel est attribuée au contact : la notification porte son nom.
create or replace function app.notification_contact_actor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.actor is null and new.session_id is not null then
    new.actor := (select coalesce(c.name, c.email) from listen_sessions s join contacts c on c.id = s.contact_id where s.id = new.session_id);
  end if;
  return new;
end $$;
revoke all on function app.notification_contact_actor() from public;
create trigger notifications_contact_actor before insert on notifications for each row execute function app.notification_contact_actor();
