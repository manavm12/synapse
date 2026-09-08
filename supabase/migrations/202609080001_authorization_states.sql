create table synapse_private.authorization_states (
  state_hash bytea primary key,
  authorization_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  superseded_at timestamptz,
  constraint authorization_states_hash_length check (octet_length(state_hash) = 32),
  constraint authorization_states_id_length check (
    char_length(authorization_id) between 1 and 512
  ),
  constraint authorization_states_lifetime check (expires_at > created_at),
  constraint authorization_states_terminal_state check (
    consumed_at is null or superseded_at is null
  )
);

create index authorization_states_authorization_created
  on synapse_private.authorization_states(authorization_id, created_at desc);
create index authorization_states_expires
  on synapse_private.authorization_states(expires_at);

revoke all on synapse_private.authorization_states from public;

create or replace function synapse_private.create_authorization_state(
  requested_authorization_id text,
  requested_state_hash bytea
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  expiration timestamptz := now() + interval '10 minutes';
  latest_created_at timestamptz;
begin
  if requested_authorization_id is null
    or char_length(requested_authorization_id) not between 1 and 512
    or requested_authorization_id !~ '^[A-Za-z0-9._~-]+$' then
    raise exception 'invalid authorization ID' using errcode = '22023';
  end if;
  if requested_state_hash is null or octet_length(requested_state_hash) <> 32 then
    raise exception 'invalid authorization state hash' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(requested_authorization_id, 0)
  );

  select state.created_at
  into latest_created_at
  from synapse_private.authorization_states as state
  where state.authorization_id = requested_authorization_id
    and state.consumed_at is null
    and state.superseded_at is null
    and state.expires_at > now()
  order by state.created_at desc
  limit 1;

  if latest_created_at > now() - interval '60 seconds' then
    raise exception 'authorization state cooldown'
      using errcode = 'P0001';
  end if;

  update synapse_private.authorization_states
  set superseded_at = now()
  where authorization_id = requested_authorization_id
    and consumed_at is null
    and superseded_at is null;

  insert into synapse_private.authorization_states (
    state_hash, authorization_id, expires_at
  ) values (
    requested_state_hash, requested_authorization_id, expiration
  );

  delete from synapse_private.authorization_states
  where expires_at < now() - interval '1 day';
  return expiration;
end
$$;

create or replace function synapse_private.consume_authorization_state(
  requested_state_hash bytea
)
returns table (authorization_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if requested_state_hash is null or octet_length(requested_state_hash) <> 32 then
    return;
  end if;

  return query
  update synapse_private.authorization_states as state
  set consumed_at = now()
  where state.state_hash = requested_state_hash
    and state.consumed_at is null
    and state.superseded_at is null
    and state.expires_at > now()
  returning state.authorization_id;
end
$$;

create or replace function synapse_private.resolve_authorization_state(
  requested_state_hash bytea
)
returns table (authorization_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select state.authorization_id
  from synapse_private.authorization_states as state
  where requested_state_hash is not null
    and octet_length(requested_state_hash) = 32
    and state.state_hash = requested_state_hash
    and state.consumed_at is null
    and state.superseded_at is null
    and state.expires_at > now()
$$;

revoke all on function synapse_private.create_authorization_state(text, bytea)
  from public, anon, authenticated;
revoke all on function synapse_private.consume_authorization_state(bytea)
  from public, anon, authenticated;
revoke all on function synapse_private.resolve_authorization_state(bytea)
  from public, anon, authenticated;
grant execute on function synapse_private.create_authorization_state(text, bytea)
  to synapse_runtime;
grant execute on function synapse_private.consume_authorization_state(bytea)
  to synapse_runtime;
grant execute on function synapse_private.resolve_authorization_state(bytea)
  to synapse_runtime;
