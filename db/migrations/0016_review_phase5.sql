-- Relecture indépendante de la phase 5 (23/11) : corrections.

-- 1. Accès paiements (lot 5.0, critère 2) : plus aucune lecture des bibliothèques privées.
--    Morceaux : seulement ceux qui ont une vente ou des collaborateurs, et seulement les colonnes utiles à la vente.
--    Versions : seulement celles qui ont été vendues (livraison du fichier). Projets : aucun accès.
revoke select on tracks, track_versions, projects, project_tracks, profiles from sonikc_payments;
drop policy if exists payments_projects on projects;
drop policy if exists payments_project_tracks on project_tracks;

grant select (id, owner_id, title, deleted_at, exclusive_sold_at, exclusive_sold_order, exclusive_reserved_until, exclusive_reserved_order)
  on tracks to sonikc_payments;
drop policy if exists payments_tracks on tracks;
create policy payments_tracks on tracks for all to sonikc_payments
  using (exists (select 1 from orders o where o.track_id = tracks.id) or exists (select 1 from track_splits s where s.track_id = tracks.id))
  with check (true);

grant select (id, track_id, original_key, format, sha256) on track_versions to sonikc_payments;
drop policy if exists payments_track_versions on track_versions;
create policy payments_track_versions on track_versions for select to sonikc_payments
  using (exists (select 1 from orders o where o.version_id = track_versions.id));

grant select (user_id, handle, display_name, plan) on profiles to sonikc_payments;

-- 2. L'app ne peut créer un profil qu'avec son identifiant et son nom : l'offre (plan) reste réservée aux paiements.
revoke insert on profiles from sonikc_app;
grant insert (user_id, handle, display_name) on profiles to sonikc_app;

-- 3. Abonnements : une seule page de paiement ouverte à la fois par compte.
alter table subscriptions add column checkout_session_id text;

-- 4. Identifiants des comptes supprimés : jamais réattribués (certificats et licences déjà émis les citent).
create table retired_handles (
  handle text primary key,
  retired_at timestamptz not null default now()
);
alter table retired_handles enable row level security;
grant select on retired_handles to sonikc_app;
create policy retired_handles_read on retired_handles for select to sonikc_app using (true);

create or replace function app.guard_retired_handle() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from retired_handles where handle = lower(new.handle)) then
    raise exception 'identifiant retiré (profiles_handle_key)' using errcode = 'unique_violation';
  end if;
  return new;
end $$;
create trigger profiles_retired_handle before insert or update of handle on profiles
  for each row execute function app.guard_retired_handle();

-- 5. Fichiers d'un compte supprimé : notés dans la même transaction que la suppression, puis effacés ;
--    un échec est repris par le worker (aucun fichier oublié).
create table pending_file_removals (
  key text primary key,
  created_at timestamptz not null default now(),
  attempts int not null default 0
);
alter table pending_file_removals enable row level security;

-- 6. Espace de stockage : la taille annoncée au début d'un envoi compte tout de suite (envois en cours compris) ;
--    le fichier reçu ne peut pas dépasser la taille annoncée.
alter table track_versions add column declared_bytes bigint check (declared_bytes >= 0);
alter table imports add column declared_bytes bigint check (declared_bytes >= 0);
