-- Relecture indépendante des ajustements du 24/11 : l'accès « compte » ne fait plus que LIRE les lignes du compte.
-- Toutes les écritures (effacement, anonymisation, détachement) passent par des fonctions de la base limitées
-- au compte courant ; la liste des tables est lue au moment de l'appel (une table ajoutée plus tard est couverte).

-- 1. Lecture seule sur toutes les tables reliées à un compte (plus de modification ni d'effacement direct).
do $$
declare
  t record;
begin
  for t in
    select c.table_name, string_agg(format('%I = app.current_user_id()', c.column_name), ' or ' order by c.column_name) as cond
    from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public'
      and c.column_name in ('owner_id', 'user_id', 'listener_id', 'actor_id', 'collaborator_id')
      and c.table_name not in ('orders', 'order_shares', 'stripe_accounts', 'subscriptions', 'users', 'profiles')
    group by c.table_name
  loop
    execute format('revoke insert, update, delete on %I from sonikc_account', t.table_name);
    execute format('grant select on %I to sonikc_account', t.table_name);
    execute format('drop policy if exists account_rows on %I', t.table_name);
    execute format('create policy account_read on %I for select to sonikc_account using (%s)', t.table_name, t.cond);
  end loop;
end $$;

-- Verrou sur ses propres morceaux (select … for update) pendant la suppression : seulement les siens.
grant update (deleted_at) on tracks to sonikc_account;
create policy account_lock on tracks for update to sonikc_account
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());

-- Profil, compte, abonnement, codes de connexion, ventes : lecture des seules lignes du compte.
drop policy account_rows on profiles;
revoke update on profiles from sonikc_account;
create policy account_read on profiles for select to sonikc_account using (user_id = app.current_user_id());

drop policy account_rows on users;
revoke update, delete on users from sonikc_account;
create policy account_read on users for select to sonikc_account using (id = app.current_user_id());

drop policy account_rows on subscriptions;
revoke delete on subscriptions from sonikc_account;
create policy account_read on subscriptions for select to sonikc_account using (user_id = app.current_user_id());

drop policy account_rows on login_codes;
revoke delete on login_codes from sonikc_account;
create policy account_read on login_codes for select to sonikc_account
  using (lower(email) = (select lower(u.email) from users u where u.id = app.current_user_id()));

drop policy account_rows on orders;
revoke update on orders from sonikc_account;
create policy account_read on orders for select to sonikc_account using (
  seller_id = app.current_user_id() or buyer_user_id = app.current_user_id()
  or lower(buyer_email) = (select lower(u.email) from users u where u.id = app.current_user_id())
  or exists (select 1 from order_shares s where s.order_id = orders.id and s.user_id = app.current_user_id())
);

-- Fichiers à effacer : un compte ne peut noter que SES fichiers ; le worker (sans compte) lit et vide la file.
drop policy account_rows on pending_file_removals;
create policy account_insert on pending_file_removals for insert to sonikc_account
  with check (app.current_user_id() is not null and key like 'u/' || app.current_user_id()::text || '/%');
create policy account_queue on pending_file_removals for select to sonikc_account using (app.current_user_id() is null);
create policy account_queue_update on pending_file_removals for update to sonikc_account using (app.current_user_id() is null) with check (true);
create policy account_queue_delete on pending_file_removals for delete to sonikc_account using (app.current_user_id() is null);

-- Identifiant retiré : seulement celui du compte courant (la fonction d'effacement s'en charge).
drop policy account_insert on retired_handles;
revoke insert on retired_handles from sonikc_account;

-- 2. Notifications : le nom d'un auditeur connecté est toujours relié à son compte (actor_id), pour pouvoir l'effacer.
create or replace function app.notification_actor() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.actor is not null and new.actor_id is null and (tg_op = 'INSERT' or old.actor is null) then
    new.actor_id := app.current_user_id();
  end if;
  return new;
end $$;
create trigger notifications_actor before insert or update of actor on notifications
  for each row execute function app.notification_actor();

-- 3. Détacher le compte des lignes des autres : nom et lien au compte effacés, lignes gardées anonymes.
create or replace function app.detach_account() returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := app.current_user_id();
  r record;
begin
  if uid is null then raise exception 'detach_account: aucun compte'; end if;
  update listen_sessions set listener_name = null where listener_id = uid;
  -- Notifications : par compte, par séance d'écoute ou par clé d'auditeur (notifications groupées).
  update notifications set actor = null
    where actor_id = uid or session_id in (select id from listen_sessions where listener_id = uid) or uid::text = any(listener_keys);
  update notifications set listener_keys = array_remove(listener_keys, uid::text) where uid::text = any(listener_keys);
  update orders set buyer_user_id = null where buyer_user_id = uid;
  for r in
    select c.table_name, c.column_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name in ('listener_id', 'actor_id')
  loop
    execute format('update %I set %I = null where %I = $1', r.table_name, r.column_name, r.column_name) using uid;
  end loop;
end $$;

-- 4. Effacer le compte courant. p_keep = des ventes doivent être gardées pour la loi : on efface tout le reste et on
--    rend le compte anonyme ; sinon le compte part entièrement (suppressions en cascade).
alter table users add column shares_renounced_at timestamptz;
create or replace function app.erase_account(p_keep boolean, p_renounce boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := app.current_user_id();
  h text;
  r record;
begin
  if uid is null then raise exception 'erase_account: aucun compte'; end if;
  select lower(handle) into h from profiles where user_id = uid;
  if h is not null and h not like 'supprime\_%' then insert into retired_handles (handle) values (h) on conflict do nothing; end if;
  delete from login_codes where lower(email) = (select lower(email) from users where id = uid);
  delete from track_splits where collaborator_id = uid;
  perform app.detach_account();
  if not p_keep then
    delete from users where id = uid;
    return;
  end if;
  for r in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'owner_id' and c.table_name not in ('orders', 'order_shares', 'stripe_accounts')
  loop
    execute format('delete from %I where owner_id = $1', r.table_name) using uid;
  end loop;
  for r in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'user_id'
      and c.table_name not in ('orders', 'order_shares', 'stripe_accounts', 'profiles', 'users')
  loop
    execute format('delete from %I where user_id = $1', r.table_name) using uid;
  end loop;
  update profiles set handle = 'supprime_' || left(replace(uid::text, '-', ''), 10), display_name = 'Compte supprimé', bio = '',
    links = '{}'::jsonb, plan = 'free' where user_id = uid;
  update users set email = 'supprime+' || uid::text || '@sonikc.invalid', google_sub = null, deleted_at = now(),
    shares_renounced_at = case when p_renounce then now() end where id = uid;
end $$;
revoke all on function app.erase_account(boolean, boolean) from public;
grant execute on function app.erase_account(boolean, boolean) to sonikc_account;
revoke all on function app.detach_account() from public, sonikc_account;

-- 5. Empreintes d'essai : effacées au bout de 3 ans (intérêt légitime : éviter les essais répétés).
grant delete on trial_marks to sonikc_payments;
