-- Seconde relecture des ajustements du 24/11.

-- 1. Les ventes vues par l'accès compte : seulement celles du compte (vendeur ou acheteur), plus celles où il a une part.
drop policy account_read on orders;
create policy account_read on orders for select to sonikc_account using (
  seller_id = app.current_user_id() or buyer_user_id = app.current_user_id()
  or lower(buyer_email) = (select lower(u.email) from users u where u.id = app.current_user_id())
);
drop policy account_rows on licence_certificates;
create policy account_read on licence_certificates for select to sonikc_account
  using (exists (select 1 from orders o where o.id = licence_certificates.order_id));

-- Argent de ventes dû au compte courant et impossible à verser (pas de compte de reversement actif) ; sans les parts
-- en litige ni celles d'une vente dont le remboursement est demandé. Fonction : l'accès compte n'a pas à lire ces ventes.
create or replace function app.account_money_owed() returns int language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(s.amount_cents), 0)::int from order_shares s join orders o on o.id = s.order_id
  where s.user_id = app.current_user_id() and s.status in ('scheduled', 'held', 'transferring') and o.refund_requested_at is null
    and not exists (select 1 from stripe_accounts a where a.user_id = app.current_user_id() and a.transfers_active)
$$;
revoke all on function app.account_money_owed() from public;
grant execute on function app.account_money_owed() to sonikc_account;

-- 2. Effacement : aussi les lignes où le compte est collaborateur (invitations), et les parts auxquelles il renonce
--    sortent des virements (plus d'essai quotidien). La renonciation n'est notée que s'il y avait de l'argent dû.
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
  for r in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'collaborator_id'
  loop
    execute format('delete from %I where collaborator_id = $1', r.table_name) using uid;
  end loop;
  perform app.detach_account();
  if p_renounce then
    update order_shares set retry_at = 'infinity', last_error = 'part abandonnée : compte supprimé avec renonciation'
      where user_id = uid and status in ('scheduled', 'held');
  end if;
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
