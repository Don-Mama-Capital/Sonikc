-- Phase 4 (choix du 20/11) : une part de collaborateur ne s'applique qu'après son accord.
-- Invitation « en attente » → acceptée ou refusée par le collaborateur seul ; changer le pourcentage ou le rôle redemande l'accord.

alter table track_splits
  add column status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  add column invited_at timestamptz not null default now(),
  add column responded_at timestamptz;

create or replace function app.guard_track_split() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := app.current_user_id();
begin
  if tg_op = 'INSERT' then
    new.status := 'pending'; new.responded_at := null; new.invited_at := now();
    return new;
  end if;
  -- Le collaborateur ne fait que répondre.
  if uid is not null and uid = old.collaborator_id then
    if (new.track_id, new.owner_id, new.collaborator_id, new.role, new.pct)
       is distinct from (old.track_id, old.owner_id, old.collaborator_id, old.role, old.pct) then
      raise exception 'split terms belong to the owner';
    end if;
    if new.status not in ('accepted', 'declined') then raise exception 'invalid split answer'; end if;
    new.responded_at := now();
    return new;
  end if;
  -- Le propriétaire ne peut pas répondre à la place du collaborateur ; changer les termes redemande l'accord.
  if (new.role, new.pct) is distinct from (old.role, old.pct) then
    new.status := 'pending'; new.responded_at := null; new.invited_at := now();
  elsif new.status is distinct from old.status and uid is not null then
    raise exception 'only the collaborator can answer';
  end if;
  return new;
end $$;
revoke all on function app.guard_track_split() from public;
create trigger track_splits_guard before insert or update on track_splits for each row execute function app.guard_track_split();

-- Une part refusée ne compte plus dans le total.
create or replace function app.check_split_total() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select coalesce(sum(pct), 0) from track_splits where track_id = coalesce(new.track_id, old.track_id) and status <> 'declined') > 100 then
    raise exception 'splits exceed 100%%';
  end if;
  return null;
end $$;

create policy track_splits_collab_answer on track_splits for update to sonikc_app
  using (collaborator_id = app.current_user_id()) with check (collaborator_id = app.current_user_id());
