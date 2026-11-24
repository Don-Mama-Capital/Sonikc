-- Lot 5.2 : abonnements (Stripe Billing, mode test). L'offre en vigueur (profiles.plan) découle de l'abonnement ;
-- seul l'accès « paiement » peut la changer.

create table subscriptions (
  user_id uuid primary key references users(id) on delete cascade,
  customer_id text not null unique check (customer_id ~ '^cus_[A-Za-z0-9_]+$'),
  subscription_id text unique,
  plan text check (plan in ('pro', 'studio')),
  period text check (period in ('month', 'year')),
  status text,
  country text check (country ~ '^[A-Z]{2}$'),
  current_period_end timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- Essai gratuit : une seule fois par compte, même après résiliation.
  trial_used boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table subscriptions enable row level security;
grant select on subscriptions to sonikc_app;
create policy subscriptions_own on subscriptions for select to sonikc_app using (user_id = app.current_user_id());

grant select, insert, update on subscriptions to sonikc_payments;
create policy payments_subscriptions on subscriptions for all to sonikc_payments using (true) with check (true);
grant update (plan) on profiles to sonikc_payments;
