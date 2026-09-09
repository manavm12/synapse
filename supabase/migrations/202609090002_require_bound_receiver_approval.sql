-- Upgrade installations that already applied the bound setup migration.
-- Existing connected legacy receivers remain usable; new approvals must bind
-- to the authenticated account/project selected by begin_receiver_setup.
create or replace function synapse_private.approve_receiver_pairing(requested_pairing_id uuid)
returns table (
  installation_id uuid, user_id uuid, username text, project_id uuid,
  project_alias text, expires_at timestamptz, enabled boolean
)
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  pairing public.receiver_pairings%rowtype;
  actor_id uuid := synapse_private.current_user_id();
begin
  select * into pairing from public.receiver_pairings where id = requested_pairing_id for update;
  if pairing.status = 'pending' and pairing.expected_owner_id is null then
    raise exception 'restart receiving setup from the Synapse plugin' using errcode = '42501';
  end if;
  if pairing.expected_owner_id is not null and (
    pairing.expected_owner_id is distinct from actor_id or not exists (
      select 1 from public.projects p where p.id = pairing.expected_project_id and p.owner_id = actor_id
    )) then
    raise exception 'sign in with the account used in Codex' using errcode = '42501';
  end if;
  return query select * from synapse_private.approve_receiver_pairing_legacy(requested_pairing_id);
end
$$;
revoke all on function synapse_private.approve_receiver_pairing(uuid) from public, anon, authenticated;
grant execute on function synapse_private.approve_receiver_pairing(uuid) to synapse_runtime;
