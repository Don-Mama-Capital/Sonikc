-- Ajustements du 24/11 (phase 5).

-- A5. Accès « compte » (export et suppression de compte) : rôle dédié sonikc_account.
--     Il ne voit et ne modifie QUE les lignes du compte concerné (app.user_id) : les siennes, et celles où il
--     apparaît chez d'autres (écoutes, collaborations, achats). Aucun accès aux autres comptes.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sonikc_account') then create role sonikc_account nologin; end if;
  begin execute format('grant sonikc_account to %I', current_user); exception when others then null; end;
end $$;
grant usage on schema public, app to sonikc_account;
grant execute on function app.current_user_id() to sonikc_account;

-- Toute table qui porte une colonne reliée à un compte : lecture, modification et effacement des seules lignes du compte.
-- (Ventes, parts et comptes de reversement : lecture seule, plus bas.)
do $$
declare
  t record;
  cond text;
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
    execute format('grant select, update, delete on %I to sonikc_account', t.table_name);
    execute format('create policy account_rows on %I for all to sonikc_account using (%s) with check (true)', t.table_name, t.cond);
  end loop;
end $$;

-- Profil : lu et rendu anonyme (jamais l'offre, écrite par l'accès paiements seul).
grant select, update (handle, display_name, bio, links) on profiles to sonikc_account;
create policy account_rows on profiles for all to sonikc_account using (user_id = app.current_user_id());

-- Le compte lui-même : lecture, anonymisation ou effacement.
grant select (id, email, google_sub, created_at, deleted_at), update (email, google_sub, deleted_at), delete on users to sonikc_account;
create policy account_rows on users for all to sonikc_account using (id = app.current_user_id()) with check (true);

-- Ventes : lecture (export, ventes en cours) ; seul le lien acheteur peut être retiré. Les verrous existants protègent le reste.
grant select on orders to sonikc_account;
grant update (buyer_user_id) on orders to sonikc_account;
create policy account_rows on orders for all to sonikc_account using (
  seller_id = app.current_user_id() or buyer_user_id = app.current_user_id()
  or lower(buyer_email) = (select lower(u.email) from users u where u.id = app.current_user_id())
) with check (true);
grant select on order_shares, stripe_accounts to sonikc_account;
create policy account_rows on order_shares for select to sonikc_account using (user_id = app.current_user_id());
create policy account_rows on stripe_accounts for select to sonikc_account using (user_id = app.current_user_id());
grant select on licence_certificates to sonikc_account;
create policy account_rows on licence_certificates for select to sonikc_account
  using (exists (select 1 from orders o where o.id = licence_certificates.order_id));

-- Abonnement : lu et effacé avec le compte (l'offre elle-même reste écrite par l'accès paiements).
grant select, delete on subscriptions to sonikc_account;
create policy account_rows on subscriptions for all to sonikc_account using (user_id = app.current_user_id());

-- Codes de connexion envoyés à l'adresse du compte.
grant select, delete on login_codes to sonikc_account;
create policy account_rows on login_codes for all to sonikc_account
  using (lower(email) = (select lower(u.email) from users u where u.id = app.current_user_id()));

-- Détacher le compte des lignes des autres (écoutes, ouvertures, notifications, achats) : après la modification, la
-- ligne ne lui appartient plus, donc ces mises à jour passent par une fonction limitée au compte courant.
create or replace function app.detach_account() returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := app.current_user_id();
  r record;
begin
  if uid is null then raise exception 'detach_account: aucun compte'; end if;
  update listen_sessions set listener_name = null where listener_id = uid;
  update notifications set actor = null where actor_id = uid;
  update orders set buyer_user_id = null where buyer_user_id = uid;
  for r in
    select c.table_name, c.column_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name in ('listener_id', 'actor_id')
  loop
    execute format('update %I set %I = null where %I = $1', r.table_name, r.column_name, r.column_name) using uid;
  end loop;
end $$;
revoke all on function app.detach_account() from public;
grant execute on function app.detach_account() to sonikc_account;

-- Identifiants retirés et fichiers à effacer.
grant insert on retired_handles to sonikc_account;
create policy account_insert on retired_handles for insert to sonikc_account with check (true);
grant select, insert, update, delete on pending_file_removals to sonikc_account;
create policy account_rows on pending_file_removals for all to sonikc_account using (true) with check (true);

-- A3. Essai gratuit une fois par personne : empreintes (HMAC, irréversibles) de l'email normalisé et de l'identifiant
--     Google des comptes qui ont eu un essai. Gardées après la suppression du compte, rien d'autre.
create table trial_marks (
  mark text primary key check (mark ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table trial_marks enable row level security;
grant select, insert on trial_marks to sonikc_payments;
create policy payments_trial_marks on trial_marks for all to sonikc_payments using (true) with check (true);
grant select (google_sub) on users to sonikc_payments;
