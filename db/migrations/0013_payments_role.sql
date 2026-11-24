-- Lot 5.0 (accord du propriétaire, 20/11) : les flux de paiement n'ont plus l'accès complet à la base.
-- Rôle dédié « sonikc_payments » : uniquement les tables et colonnes dont l'achat, le webhook Stripe, la livraison,
-- les virements, les remboursements et les invitations de collaborateurs ont besoin. Rien sur les bibliothèques
-- privées (au-delà des colonnes lues pour vendre), les contacts, les campagnes, les liens, les écoutes ni les sessions.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sonikc_payments') then create role sonikc_payments nologin; end if;
  begin execute format('grant sonikc_payments to %I', current_user); exception when others then null; end;
end $$;

grant usage on schema public to sonikc_payments;
grant usage on schema app to sonikc_payments;

-- Lecture : ce qu'il faut pour vendre, livrer et prévenir les bonnes personnes.
grant select (id, email) on users to sonikc_payments;
grant select on profiles, tracks, track_versions, projects, project_tracks, licence_templates, track_licences, track_splits to sonikc_payments;

-- Morceaux : seulement l'exclusivité (réservation et vente).
grant update (exclusive_sold_at, exclusive_sold_order, exclusive_reserved_until, exclusive_reserved_order) on tracks to sonikc_payments;

-- Ventes et ce qui en découle.
grant select, insert, update on orders, order_shares, stripe_accounts, invoice_counters, stripe_events to sonikc_payments;
grant select, insert on order_files, licence_certificates, split_invite_log to sonikc_payments;

-- Tâches du worker (livraison, virements, avoirs, remboursements) : ajout et lecture pour éviter les doublons.
grant select, insert on jobs to sonikc_payments;
grant usage on sequence jobs_id_seq to sonikc_payments;

-- Politiques : ce rôle voit toutes les lignes des tables ci-dessus (les droits par table et par colonne le bornent).
do $$
declare t text;
begin
  foreach t in array array['users', 'profiles', 'tracks', 'track_versions', 'projects', 'project_tracks', 'licence_templates',
    'track_licences', 'track_splits', 'orders', 'order_shares', 'stripe_accounts', 'invoice_counters', 'stripe_events',
    'order_files', 'licence_certificates', 'split_invite_log', 'jobs'] loop
    execute format('create policy %I on %I for all to sonikc_payments using (true) with check (true)', 'payments_' || t, t);
  end loop;
end $$;
