alter table public.receiver_pairings
  add column expected_owner_id uuid references public.profiles(id) on delete cascade,
  add column expected_project_id uuid references public.projects(id) on delete cascade,
  add constraint receiver_pairing_expected_identity check (
    (expected_owner_id is null) = (expected_project_id is null)
  );

create function synapse_private.create_bound_receiver_pairing(candidate_hash bytea)
returns table(pairing_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  actor_id uuid := synapse_private.current_user_id();
  target_project_id uuid;
  existing public.receiver_pairings%rowtype;
  created record;
begin
  select project.id into target_project_id from public.projects project
    join public.profiles profile on profile.id = project.owner_id
    where project.owner_id = actor_id and profile.status = 'active';
  if actor_id is null or target_project_id is null then
    raise exception 'active authenticated account is required' using errcode = '42501';
  end if;
  if candidate_hash is null or octet_length(candidate_hash) <> 32 then
    raise exception 'invalid pairing hash' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(encode(candidate_hash, 'hex'), 0));
  select * into existing from public.receiver_pairings where credential_hash = candidate_hash for update;
  if existing.id is not null and (existing.expected_owner_id is distinct from actor_id
      or existing.expected_project_id is distinct from target_project_id) then
    raise exception 'pairing belongs to another setup' using errcode = '42501';
  end if;
  select * into created from synapse_private.create_receiver_pairing(
    candidate_hash, extensions.digest('receiver-setup:' || actor_id::text, 'sha256'));
  update public.receiver_pairings set expected_owner_id = actor_id,
    expected_project_id = target_project_id where id = created.pairing_id;
  return query select created.pairing_id::uuid, created.expires_at::timestamptz;
end
$$;
revoke all on function synapse_private.create_bound_receiver_pairing(bytea) from public, anon, authenticated;
grant execute on function synapse_private.create_bound_receiver_pairing(bytea) to synapse_runtime;

alter function synapse_private.approve_receiver_pairing(uuid) rename to approve_receiver_pairing_legacy;
revoke all on function synapse_private.approve_receiver_pairing_legacy(uuid) from public, anon, authenticated, synapse_runtime;

create function synapse_private.approve_receiver_pairing(requested_pairing_id uuid)
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
