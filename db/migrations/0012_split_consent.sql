-- Phase 4 (choix du 20/11) : une part de collaborateur ne s'applique qu'avec son accord, et la base l'impose.
--  * Le propriétaire propose (pourcentage, rôle) ; seul le collaborateur accepte, refuse ou se retire.
--  * Les conditions acceptées restent en vigueur tant que de nouvelles ne sont pas acceptées (accepted_pct / accepted_role).
--  * Personne, pas même le propriétaire, ne peut déplacer une ligne vers une autre personne ou un autre morceau.

alter table track_splits
  add column status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  add column invited_at timestamptz not null default now(),
  add column responded_at timestamptz,
  add column accepted_pct numeric(5, 2) check (accepted_pct > 0 and accepted_pct <= 100),
  add column accepted_role text,
  add column accepted_at timestamptz;

create or replace function app.guard_track_split() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := app.current_user_id();
begin
  if tg_op = 'INSERT' then
    new.status := 'pending'; new.invited_at := now(); new.responded_at := null;
    new.accepted_pct := null; new.accepted_role := null; new.accepted_at := null;
    return new;
  end if;
  if (new.track_id, new.owner_id, new.collaborator_id) is distinct from (old.track_id, old.owner_id, old.collaborator_id) then
    raise exception 'a split cannot be moved to another track or person';
  end if;
  -- Horodatages et conditions en vigueur : posés ici seulement.
  new.invited_at := old.invited_at; new.responded_at := old.responded_at;
  new.accepted_pct := old.accepted_pct; new.accepted_role := old.accepted_role; new.accepted_at := old.accepted_at;

  if uid is not null and uid = old.collaborator_id then
    -- Le collaborateur répond seulement : accepter ou refuser une proposition, ou se retirer d'une part en vigueur.
    if (new.role, new.pct) is distinct from (old.role, old.pct) then raise exception 'split terms belong to the owner'; end if;
    if old.status = 'pending' and new.status in ('accepted', 'declined') then
      new.responded_at := now();
      if new.status = 'accepted' then
        new.accepted_pct := new.pct; new.accepted_role := new.role; new.accepted_at := now();
      end if;
    elsif new.status = 'withdrawn' and old.status <> 'withdrawn' then
      new.responded_at := now(); new.accepted_pct := null; new.accepted_role := null; new.accepted_at := null;
    elsif new.status is distinct from old.status then
      raise exception 'invalid split answer';
    end if;
    return new;
  end if;

  -- Propriétaire (ou serveur) : jamais de réponse à la place du collaborateur ; de nouvelles conditions redemandent l'accord.
  if (new.role, new.pct) is distinct from (old.role, old.pct) then
    new.status := 'pending'; new.invited_at := now(); new.responded_at := null;
  elsif new.status is distinct from old.status then
    raise exception 'only the collaborator can answer';
  end if;
  return new;
end $$;
revoke all on function app.guard_track_split() from public;
create trigger track_splits_guard before insert or update on track_splits for each row execute function app.guard_track_split();

-- Total ≤ 100 % : pour chaque collaborateur, la plus grande part entre la proposition en cours et celle en vigueur.
create or replace function app.check_split_total() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select coalesce(sum(greatest(case when status = 'pending' or status = 'accepted' then pct else 0 end, coalesce(accepted_pct, 0))), 0)
      from track_splits where track_id = coalesce(new.track_id, old.track_id)) > 100 then
    raise exception 'splits exceed 100%%';
  end if;
  return null;
end $$;

-- Droits par colonne : le propriétaire change pourcentage et rôle, le collaborateur sa réponse.
revoke update on track_splits from sonikc_app;
grant update (role, pct, status) on track_splits to sonikc_app;
create policy track_splits_collab_answer on track_splits for update to sonikc_app
  using (collaborator_id = app.current_user_id()) with check (collaborator_id = app.current_user_id());

-- Invitations envoyées : au plus une par personne et par producteur toutes les 24 h, même après retrait puis nouvel ajout.
create table split_invite_log (
  owner_id uuid not null references users(id) on delete cascade,
  collaborator_id uuid not null references users(id) on delete cascade,
  sent_at timestamptz not null default now()
);
create index split_invite_log_idx on split_invite_log (owner_id, sent_at);
alter table split_invite_log enable row level security;

-- Virement en cours d'envoi : réservé avant l'appel à Stripe, pour qu'un remboursement ne puisse pas s'intercaler.
alter table order_shares drop constraint order_shares_status_check;
alter table order_shares add constraint order_shares_status_check
  check (status in ('scheduled', 'held', 'disputed', 'transferring', 'transferred', 'canceled', 'reversed'));
