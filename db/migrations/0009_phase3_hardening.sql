-- Phase 3, itération 2 : corrections de la relecture de sécurité indépendante.

-- 1. Liste d'exclusion définitive : une désinscription survit à la suppression ou à la réimportation du contact.
create table email_suppressions (
  owner_id uuid not null references users(id) on delete cascade,
  email text not null check (email = lower(email)),
  created_at timestamptz not null default now(),
  primary key (owner_id, email)
);
insert into email_suppressions (owner_id, email)
  select owner_id, email from contacts where unsubscribed_at is not null on conflict do nothing;
grant select on email_suppressions to sonikc_app; -- lecture seule : le producteur ne peut pas l'effacer
alter table email_suppressions enable row level security;
create policy email_suppressions_owner on email_suppressions for select to sonikc_app using (owner_id = app.current_user_id());

-- Le producteur ne touche plus à la désinscription d'un contact (seuls nom et tags sont modifiables).
revoke insert, update on contacts from sonikc_app;
grant insert (owner_id, email, name, tags) on contacts to sonikc_app;
grant update (name, tags) on contacts to sonikc_app;
-- Pas de caractère de contrôle (retour à la ligne compris) dans un nom de contact.
alter table contacts add constraint contacts_name_clean check (name is null or name !~ '[[:cntrl:]]');

-- Campagnes : seule l'annulation de la relance est modifiable directement (le reste passe par des fonctions).
revoke update on campaigns from sonikc_app;
grant update (followup_status) on campaigns to sonikc_app;
alter table campaigns add constraint campaigns_subject_clean check (subject !~ '[\r\n]' and (followup_subject is null or followup_subject !~ '[\r\n]'));

-- 10. Rôle dédié aux liens publics des emails : il ne peut qu'appeler app.email_event.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'sonikc_public') then create role sonikc_public nologin; end if;
  begin execute format('grant sonikc_public to %I', current_user); exception when others then null; end;
end $$;
grant usage on schema app to sonikc_public;
revoke execute on function app.email_event(uuid, text) from sonikc_app;

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
    insert into email_suppressions (owner_id, email) values (s.owner_id, lower(s.email)) on conflict do nothing;
    update contacts set unsubscribed_at = coalesce(unsubscribed_at, now()) where owner_id = s.owner_id and email = lower(s.email);
    update email_sends set status = 'skipped', skip_reason = 'unsubscribed'
      where owner_id = s.owner_id and lower(email) = lower(s.email) and status = 'queued';
  else
    raise exception 'unknown kind';
  end if;
  return s.link_id;
end $$;
revoke all on function app.email_event(uuid, text) from public;
grant execute on function app.email_event(uuid, text) to sonikc_public;

-- 2. Contact supprimé (demande d'effacement) : rien de ce qui est en file ne part.
create or replace function app.skip_sends_of_deleted_contact() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update email_sends set status = 'skipped', skip_reason = 'contact_deleted' where contact_id = old.id and status = 'queued';
  return old;
end $$;
revoke all on function app.skip_sends_of_deleted_contact() from public;
create trigger contacts_skip_sends before delete on contacts for each row execute function app.skip_sends_of_deleted_contact();

-- 3. Rattachement par email limité aux personnes invitées (dont le producteur connaît déjà l'adresse) :
-- importer des adresses ne permet pas de deviner qui se cache derrière « Auditeur connecté ».
create or replace function app.contact_for(p_owner uuid, p_link uuid, p_user uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select l.contact_id from share_links l join contacts c on c.id = l.contact_id and c.owner_id = p_owner where l.id = p_link),
    (select c.id from contacts c join users u on lower(u.email) = c.email
     join share_links l on l.id = p_link
     where c.owner_id = p_owner and u.id = p_user
       and exists (select 1 from invites i where i.owner_id = p_owner and i.revoked_at is null and lower(i.email) = c.email
                   and (i.link_id = l.id or (l.project_id is not null and i.project_id = l.project_id)
                        or (l.track_id is not null and i.track_id = l.track_id)))))
$$;

-- 9. Annuler une campagne retire aussi les invitations et les liens personnels jamais envoyés.
create or replace function app.cancel_campaign(p_campaign uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update campaigns set status = 'cancelled',
         followup_status = case when followup_status = 'scheduled' then 'cancelled' else followup_status end
    where id = p_campaign and owner_id = app.current_user_id() and status in ('scheduled', 'sending');
  if not found then return false; end if;
  update email_sends set status = 'skipped', skip_reason = 'cancelled' where campaign_id = p_campaign and status = 'queued';
  update invites set revoked_at = coalesce(revoked_at, now())
    where link_id in (select link_id from email_sends where campaign_id = p_campaign and step = 0 and status = 'skipped' and skip_reason = 'cancelled');
  update share_links set revoked_at = coalesce(revoked_at, now())
    where id in (select link_id from email_sends where campaign_id = p_campaign and step = 0 and status = 'skipped' and skip_reason = 'cancelled');
  return true;
end $$;
revoke all on function app.cancel_campaign(uuid) from public;
grant execute on function app.cancel_campaign(uuid) to sonikc_app;
