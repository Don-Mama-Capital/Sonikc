-- Phase 4, lot 4.3-4.4 : ventes (mode test Stripe), parts des collaborateurs, factures, certificats.
-- Toutes les écritures passent par le serveur (flux de paiement) ; l'app ne fait que lire ce qui la concerne.

-- ───────── Comptes de reversement (Stripe Connect Express) ─────────
create table stripe_accounts (
  user_id uuid primary key references users(id) on delete restrict,
  account_id text not null unique check (account_id ~ '^acct_[A-Za-z0-9]+$'),
  country text not null check (country ~ '^[A-Z]{2}$'),
  transfers_active boolean not null default false,
  details_submitted boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ───────── Collaborateurs d'un morceau ─────────
create table track_splits (
  track_id uuid not null references tracks(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  collaborator_id uuid not null references users(id) on delete restrict,
  role text not null default '' check (length(role) <= 40),
  pct numeric(5, 2) not null check (pct > 0 and pct <= 100),
  primary key (track_id, collaborator_id),
  check (collaborator_id <> owner_id)
);

create or replace function app.check_track_split() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select owner_id from tracks where id = new.track_id) is distinct from new.owner_id then
    raise exception 'track belongs to another user';
  end if;
  return new;
end $$;
revoke all on function app.check_track_split() from public;
create trigger track_splits_owner before insert or update on track_splits for each row execute function app.check_track_split();

-- Total des parts ≤ 100 % (vérifié en fin de transaction : on peut remplacer toute la liste d'un coup).
create or replace function app.check_split_total() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select coalesce(sum(pct), 0) from track_splits where track_id = coalesce(new.track_id, old.track_id)) > 100 then
    raise exception 'splits exceed 100%%';
  end if;
  return null;
end $$;
revoke all on function app.check_split_total() from public;
create constraint trigger track_splits_total after insert or update on track_splits
  deferrable initially deferred for each row execute function app.check_split_total();

-- ───────── Commandes ─────────
alter table tracks add column exclusive_sold_order uuid;

create table orders (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references users(id) on delete restrict,
  track_id uuid references tracks(id) on delete set null,
  version_id uuid references track_versions(id) on delete set null,
  template_id uuid references licence_templates(id) on delete set null,
  -- Instantané de ce qui a été vendu : la licence ou le titre peuvent changer ensuite.
  track_title text not null,
  seller_name text not null,
  licence jsonb not null,
  exclusive boolean not null,
  buyer_email text not null check (buyer_email ~ '^[^@\s]+@[^@\s]+$'),
  buyer_user_id uuid references users(id) on delete set null,
  -- Pays de l'acheteur : déclaré (base de la TVA) et preuve de la carte.
  country text not null check (country ~ '^[A-Z]{2}$'),
  card_country text,
  -- Les deux preuves du pays se contredisent (pays déclaré ≠ pays de la carte) : à revoir par le comptable.
  country_conflict boolean not null default false,
  ip_hash text,
  net_cents int not null check (net_cents >= 100),
  vat_rate numeric(4, 1) not null check (vat_rate >= 0 and vat_rate < 50),
  vat_cents int not null check (vat_cents >= 0),
  gross_cents int not null check (gross_cents = net_cents + vat_cents),
  plan text not null,
  commission_pct numeric(5, 2) not null check (commission_pct >= 0 and commission_pct <= 100),
  commission_cents int not null check (commission_cents >= 0),
  stripe_fee_cents int check (stripe_fee_cents >= 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'expired')),
  checkout_session_id text unique,
  payment_intent_id text unique,
  charge_id text,
  invoice_no text unique,
  credit_note_no text unique,
  refund_reason text,
  -- Remboursement décidé mais pas encore confirmé par Stripe (repris par le balayage s'il échoue).
  refund_requested_at timestamptz,
  disputed_at timestamptz,
  buyer_notified_at timestamptz,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  transfers_due_at timestamptz,
  delivered_at timestamptz,
  refunded_at timestamptz,
  check (status <> 'paid' or (paid_at is not null and invoice_no is not null)),
  check (status <> 'refunded' or (refunded_at is not null and credit_note_no is not null))
);
create index orders_seller_idx on orders (seller_id, created_at desc);
create index orders_buyer_idx on orders (lower(buyer_email));
create index orders_pending_idx on orders (ip_hash, created_at) where status = 'pending';
create index orders_track_recent_idx on orders (track_id, created_at) where exclusive;

-- Parts figées au paiement : qui touche quoi. Seul le statut du virement évolue.
create table order_shares (
  order_id uuid not null references orders(id) on delete restrict,
  user_id uuid not null references users(id) on delete restrict,
  is_owner boolean not null,
  role text not null default '',
  pct numeric(5, 2) not null check (pct >= 0 and pct <= 100),
  amount_cents int not null check (amount_cents >= 0),
  status text not null default 'scheduled' check (status in ('scheduled', 'held', 'disputed', 'transferred', 'canceled', 'reversed')),
  transfer_id text,
  -- Essais auprès de Stripe (dans la clé d'idempotence) et prochain essai : rien n'est abandonné.
  attempts int not null default 0,
  retry_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (order_id, user_id)
);

create index order_shares_open_idx on order_shares (status, retry_at) where status in ('scheduled', 'held', 'transferred');

-- Numérotation des factures et avoirs : une série par type et par année, sans trou (ligne verrouillée dans la transaction).
create table invoice_counters (series text primary key, last_no int not null default 0);

create table order_files (
  order_id uuid not null references orders(id) on delete restrict,
  kind text not null check (kind in ('mp3', 'wav', 'licence', 'invoice', 'credit_note')),
  storage_key text not null,
  filename text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null,
  created_at timestamptz not null default now(),
  primary key (order_id, kind)
);

-- Certificat de licence : émis une fois, jamais modifié ni supprimé.
create table licence_certificates (
  order_id uuid primary key references orders(id) on delete restrict,
  issued_at timestamptz not null default now(),
  files jsonb not null,      -- [{ format, filename, sha256, size }]
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  parties jsonb not null,    -- producteur, acheteur, collaborateurs et parts
  terms jsonb not null       -- licence vendue
);

create table stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

-- ───────── Verrous posés par la base ─────────
create or replace function app.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is locked once issued', tg_table_name;
end $$;
create trigger licence_certificates_locked before update or delete on licence_certificates
  for each row execute function app.forbid_change();
create trigger order_files_locked before update or delete on order_files
  for each row execute function app.forbid_change();

create or replace function app.lock_order_shares() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'order_shares is locked once issued'; end if;
  if (new.order_id, new.user_id, new.is_owner, new.pct, new.amount_cents, new.role)
     is distinct from (old.order_id, old.user_id, old.is_owner, old.pct, old.amount_cents, old.role) then
    raise exception 'order_shares is locked once issued';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger order_shares_locked before update or delete on order_shares
  for each row execute function app.lock_order_shares();

-- Une fois payée, ce qui a été vendu et à quel prix ne change plus.
create or replace function app.lock_paid_order() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'orders cannot be deleted'; end if;
  if old.status <> 'pending' and (new.seller_id, new.track_title, new.seller_name, new.licence, new.exclusive, new.buyer_email, new.country,
      new.net_cents, new.vat_rate, new.vat_cents, new.gross_cents, new.commission_pct, new.commission_cents, new.invoice_no, new.paid_at)
     is distinct from (old.seller_id, old.track_title, old.seller_name, old.licence, old.exclusive, old.buyer_email, old.country,
      old.net_cents, old.vat_rate, old.vat_cents, old.gross_cents, old.commission_pct, old.commission_cents, old.invoice_no, old.paid_at) then
    raise exception 'order is locked once paid';
  end if;
  if old.credit_note_no is not null and new.credit_note_no is distinct from old.credit_note_no then
    raise exception 'order is locked once paid';
  end if;
  return new;
end $$;
create trigger orders_locked before update or delete on orders for each row execute function app.lock_paid_order();

-- ───────── Lecture par l'app ─────────
create or replace function app.current_email() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select lower(email) from users where id = app.current_user_id()
$$;
revoke all on function app.current_email() from public;
grant execute on function app.current_email() to sonikc_app;

grant select on stripe_accounts, orders, order_shares, order_files, licence_certificates to sonikc_app;
grant select, insert, update, delete on track_splits to sonikc_app;
alter table stripe_accounts enable row level security;
alter table track_splits enable row level security;
alter table orders enable row level security;
alter table order_shares enable row level security;
alter table order_files enable row level security;
alter table licence_certificates enable row level security;
alter table invoice_counters enable row level security;
alter table stripe_events enable row level security;

create policy stripe_accounts_own on stripe_accounts for select to sonikc_app using (user_id = app.current_user_id());
create policy track_splits_owner on track_splits for all to sonikc_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy track_splits_collab on track_splits for select to sonikc_app using (collaborator_id = app.current_user_id());

-- Une commande se lit par son vendeur, ses collaborateurs payés, ou son acheteur (compte ou même adresse email).
create or replace function app.order_visible(p_order uuid, p_seller uuid, p_buyer uuid, p_email text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.current_user_id() is not null and (
    p_seller = app.current_user_id() or p_buyer = app.current_user_id()
    or lower(p_email) = app.current_email()
    or exists (select 1 from order_shares s where s.order_id = p_order and s.user_id = app.current_user_id()))
$$;
revoke all on function app.order_visible(uuid, uuid, uuid, text) from public;
grant execute on function app.order_visible(uuid, uuid, uuid, text) to sonikc_app;

create policy orders_visible on orders for select to sonikc_app
  using (status in ('paid', 'refunded') and app.order_visible(id, seller_id, buyer_user_id, buyer_email));
-- Chaque collaborateur voit sa ligne ; le vendeur voit toutes les lignes de ses ventes.
create policy order_shares_visible on order_shares for select to sonikc_app
  using (user_id = app.current_user_id() or exists (select 1 from orders o where o.id = order_id and o.seller_id = app.current_user_id()));
create policy order_files_visible on order_files for select to sonikc_app
  using (exists (select 1 from orders o where o.id = order_id));
create policy licence_certificates_visible on licence_certificates for select to sonikc_app
  using (exists (select 1 from orders o where o.id = order_id));
