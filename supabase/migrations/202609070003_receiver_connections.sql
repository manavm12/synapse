create type public.receiver_pairing_status as enum (
  'pending', 'approved', 'cancelled'
);
create type public.message_delivery_kind as enum (
  'provisioning', 'delivered', 'needs_attention'
);

create table public.receiver_pairings (
  id uuid primary key default gen_random_uuid(),
  credential_hash bytea not null unique,
  requester_hash bytea not null,
  status public.receiver_pairing_status not null default 'pending',
  owner_id uuid references public.profiles(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  installation_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  approved_at timestamptz,
  cancelled_at timestamptz,
  constraint receiver_pairings_hash_length check (
    octet_length(credential_hash) = 32 and octet_length(requester_hash) = 32
  ),
  constraint receiver_pairings_decision_shape check (
    (status = 'pending' and owner_id is null and project_id is null
      and installation_id is null and approved_at is null and cancelled_at is null)
    or
    (status = 'approved' and owner_id is not null and project_id is not null
      and installation_id is not null and approved_at is not null
      and cancelled_at is null)
    or
    (status = 'cancelled' and owner_id is null and project_id is null
      and installation_id is null and approved_at is null
      and cancelled_at is not null)
  )
);

create index receiver_pairings_requester_created
  on public.receiver_pairings(requester_hash, created_at desc);

alter table public.projects add constraint projects_id_owner_unique unique (id, owner_id);

create table public.receiver_installations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  credential_hash bytea not null unique,
  enabled boolean not null default true,
  expires_at timestamptz not null default (now() + interval '90 days'),
  revoked_at timestamptz,
  last_contact_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint receiver_installations_hash_length check (octet_length(credential_hash) = 32),
  constraint receiver_installations_owner_project_fk foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade,
  constraint receiver_installations_enabled_shape check (
    (enabled and revoked_at is null) or not enabled
  ),
  unique (id, owner_id, project_id)
);

create unique index receiver_installations_one_enabled_project
  on public.receiver_installations(project_id) where enabled and revoked_at is null;

alter table public.receiver_pairings
  add constraint receiver_pairings_installation_fk
  foreign key (installation_id, owner_id, project_id)
  references public.receiver_installations(id, owner_id, project_id)
  on delete cascade;

alter table public.message_jobs
  add column assigned_installation_id uuid,
  add column claim_token_hash bytea,
  add column claim_expires_at timestamptz,
  add constraint message_jobs_assignment_fk foreign key (
    assigned_installation_id, recipient_id, recipient_project_id
  ) references public.receiver_installations(id, owner_id, project_id),
  add constraint message_jobs_claim_shape check (
    (assigned_installation_id is null and claim_token_hash is null and claim_expires_at is null)
    or
    (assigned_installation_id is not null and octet_length(claim_token_hash) = 32
      and claim_expires_at is not null)
  );

alter table public.message_jobs
  add constraint message_jobs_id_assignment_unique unique (id, assigned_installation_id);

create table public.message_delivery_events (
  event_id uuid primary key,
  message_id uuid not null,
  receiver_installation_id uuid not null,
  claim_token_hash bytea not null,
  kind public.message_delivery_kind not null,
  occurred_at timestamptz not null,
  error_code text,
  received_at timestamptz not null default now(),
  constraint message_delivery_events_assignment_fk foreign key (
    message_id, receiver_installation_id
  ) references public.message_jobs(id, assigned_installation_id) on delete cascade,
  constraint message_delivery_events_claim_hash_length check (
    octet_length(claim_token_hash) = 32
  ),
  constraint message_delivery_events_error_shape check (
    (kind = 'needs_attention' and error_code ~ '^[a-z0-9_]{1,64}$')
    or (kind <> 'needs_attention' and error_code is null)
  )
);

create index message_delivery_events_message_received
  on public.message_delivery_events(message_id, received_at);

create trigger receiver_installations_set_updated_at
before update on public.receiver_installations
for each row execute function synapse_private.set_updated_at();

alter table public.receiver_pairings enable row level security;
alter table public.receiver_pairings force row level security;
alter table public.receiver_installations enable row level security;
alter table public.receiver_installations force row level security;
alter table public.message_delivery_events enable row level security;
alter table public.message_delivery_events force row level security;

revoke all on public.receiver_pairings, public.receiver_installations,
  public.message_delivery_events from public, anon, authenticated, synapse_runtime;

create or replace function synapse_private.receiver_identity(candidate_hash bytea)
returns table (
  installation_id uuid, user_id uuid, username text, project_id uuid,
  project_alias text, expires_at timestamptz, enabled boolean
)
language sql
security definer
set search_path = ''
set row_security = off
as $$
  select installation.id, profile.id, profile.username::text, project.id,
    project.alias::text, installation.expires_at, true
  from public.receiver_installations as installation
  join public.profiles as profile on profile.id = installation.owner_id
  join public.projects as project
    on project.id = installation.project_id and project.owner_id = profile.id
  where installation.credential_hash = candidate_hash
    and installation.enabled and installation.revoked_at is null
    and installation.expires_at > now() and profile.status = 'active'
$$;

create or replace function synapse_private.create_receiver_pairing(
  candidate_hash bytea, request_hash bytea
)
returns table(pairing_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  existing public.receiver_pairings%rowtype;
  created public.receiver_pairings%rowtype;
begin
  if candidate_hash is null or request_hash is null
    or octet_length(candidate_hash) <> 32
    or octet_length(request_hash) <> 32 then
    raise exception 'invalid pairing hash' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(encode(candidate_hash, 'hex'), 0));
  select * into existing from public.receiver_pairings
    where credential_hash = candidate_hash for update;
  if found and existing.status = 'cancelled' then
    raise exception 'cancelled credential cannot be reused' using errcode = '23505';
  end if;
  if found and (
    existing.status = 'approved'
    or (existing.status = 'pending' and existing.expires_at > now())
  ) then
    return query select existing.id, existing.expires_at;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(encode(request_hash, 'hex'), 1));
  if (select count(*) from public.receiver_pairings
      where requester_hash = request_hash and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'pairing rate limit exceeded' using errcode = '54000';
  end if;
  if existing.id is not null then
    update public.receiver_pairings set
      id = gen_random_uuid(), requester_hash = request_hash, status = 'pending',
      owner_id = null, project_id = null, installation_id = null,
      created_at = now(), expires_at = now() + interval '10 minutes',
      approved_at = null, cancelled_at = null
    where credential_hash = candidate_hash returning * into created;
  else
    insert into public.receiver_pairings (credential_hash, requester_hash)
    values (candidate_hash, request_hash) returning * into created;
  end if;
  return query select created.id, created.expires_at;
end
$$;

create or replace function synapse_private.approve_receiver_pairing(
  requested_pairing_id uuid
)
returns table (
  installation_id uuid, user_id uuid, username text, project_id uuid,
  project_alias text, expires_at timestamptz, enabled boolean
)
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  actor_id uuid := synapse_private.current_user_id();
  pairing public.receiver_pairings%rowtype;
  project public.projects%rowtype;
  installation public.receiver_installations%rowtype;
  actor_username text;
begin
  if actor_id is null then
    raise exception 'authenticated identity is required' using errcode = '42501';
  end if;
  select * into pairing from public.receiver_pairings
    where id = requested_pairing_id for update;
  if pairing.id is null
    or pairing.status = 'cancelled'
    or (pairing.status = 'pending' and pairing.expires_at <= now()) then
    raise exception 'pairing is unavailable or expired' using errcode = 'P0002';
  end if;
  if pairing.status = 'approved' then
    if pairing.owner_id is distinct from actor_id then
      raise exception 'pairing belongs to another account' using errcode = '42501';
    end if;
    return query select * from synapse_private.receiver_identity(pairing.credential_hash);
    if not found then
      raise exception 'receiver is inactive' using errcode = '42501';
    end if;
    return;
  end if;
  select owned_project.* into project
  from public.projects as owned_project
  join public.profiles as profile on profile.id = owned_project.owner_id
  where owned_project.owner_id = actor_id and profile.status = 'active';
  if project.id is null then
    raise exception 'active account and project are required' using errcode = '42501';
  end if;
  select profile.username::text into actor_username
  from public.profiles as profile where profile.id = actor_id;
  select enabled_installation.* into installation
  from public.receiver_installations as enabled_installation
  where enabled_installation.project_id = project.id
    and enabled_installation.enabled
    and enabled_installation.revoked_at is null
  for update;
  if installation.id is not null
    and installation.credential_hash is distinct from pairing.credential_hash then
    raise exception 'project already has an enabled receiver' using errcode = '23505';
  end if;
  if installation.id is null then
    insert into public.receiver_installations (owner_id, project_id, credential_hash)
    values (actor_id, project.id, pairing.credential_hash)
    returning * into installation;
  end if;
  update public.receiver_pairings set status = 'approved', owner_id = actor_id,
    project_id = project.id, installation_id = installation.id, approved_at = now()
  where id = pairing.id;
  return query select installation.id, actor_id, actor_username, project.id,
    project.alias::text, installation.expires_at, true;
end
$$;

create or replace function synapse_private.complete_receiver_pairing(
  requested_pairing_id uuid, candidate_hash bytea
)
returns table (
  pairing_status text, installation_id uuid, user_id uuid, username text,
  project_id uuid, project_alias text, expires_at timestamptz, enabled boolean
)
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare pairing public.receiver_pairings%rowtype;
begin
  select * into pairing from public.receiver_pairings
    where id = requested_pairing_id and credential_hash = candidate_hash;
  if pairing.id is null
    or pairing.status = 'cancelled'
    or (pairing.status = 'pending' and pairing.expires_at <= now()) then
    raise exception 'pairing is unavailable or expired' using errcode = 'P0002';
  end if;
  if pairing.status = 'pending' then
    return query select 'pending'::text, null::uuid, null::uuid, null::text,
      null::uuid, null::text, null::timestamptz, null::boolean;
  else
    return query select 'connected'::text, identity.installation_id,
      identity.user_id, identity.username, identity.project_id,
      identity.project_alias, identity.expires_at, identity.enabled
    from synapse_private.receiver_identity(candidate_hash) as identity;
    if not found then
      raise exception 'receiver is inactive' using errcode = '42501';
    end if;
  end if;
end
$$;

create or replace function synapse_private.claim_receiver_messages(
  candidate_hash bytea, requested_limit integer
)
returns table (
  installation_id uuid, user_id uuid, username text, project_id uuid,
  project_alias text, receiver_expires_at timestamptz, message_id uuid,
  conversation_id uuid, message_sequence bigint, sender_id uuid,
  sender_username text, message text, content_hash text, claim_token text,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare identity record;
declare job record;
declare token text;
begin
  select * into identity from synapse_private.receiver_identity(candidate_hash);
  if identity.installation_id is null then
    raise exception 'receiver is unauthorized' using errcode = '42501';
  end if;
  if requested_limit not between 1 and 10 then
    raise exception 'claim limit must be between 1 and 10' using errcode = '22023';
  end if;
  update public.receiver_installations set last_contact_at = now()
    where id = identity.installation_id;
  for job in
    select queued.* from public.message_jobs as queued
    where queued.recipient_id = identity.user_id
      and queued.recipient_project_id = identity.project_id
      and queued.imported_at is null
      and (queued.assigned_installation_id is null
        or (queued.assigned_installation_id = identity.installation_id
          and queued.claim_expires_at <= now()))
      and not exists (
        select 1 from public.message_jobs as earlier
        where earlier.conversation_id = queued.conversation_id
          and earlier.recipient_id = queued.recipient_id
          and earlier.sequence < queued.sequence
          and earlier.imported_at is null
          and not (
            earlier.assigned_installation_id is null
            or (
              earlier.assigned_installation_id = identity.installation_id
              and earlier.claim_expires_at <= now()
            )
          )
      )
    order by (
      select min(first_pending.queued_at)
      from public.message_jobs as first_pending
      where first_pending.conversation_id = queued.conversation_id
        and first_pending.recipient_id = queued.recipient_id
        and first_pending.imported_at is null
    ), queued.conversation_id, queued.sequence
    for update skip locked limit requested_limit
  loop
    token := encode(extensions.gen_random_bytes(32), 'hex');
    update public.message_jobs set
      assigned_installation_id = identity.installation_id,
      claim_token_hash = extensions.digest(convert_to(token, 'UTF8'), 'sha256'),
      claim_expires_at = now() + interval '60 seconds'
    where id = job.id;
    return query select identity.installation_id, identity.user_id,
      identity.username, identity.project_id, identity.project_alias,
      identity.expires_at, job.id, job.conversation_id, job.sequence,
      job.sender_id, sender.username::text, job.message, job.content_hash,
      token, now() + interval '60 seconds'
    from public.profiles as sender where sender.id = job.sender_id;
  end loop;
end
$$;

create or replace function synapse_private.import_receiver_message(
  candidate_hash bytea, requested_message_id uuid, candidate_claim_hash bytea
)
returns table(message_id uuid, public_status text)
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare identity record;
declare job public.message_jobs%rowtype;
begin
  select * into identity from synapse_private.receiver_identity(candidate_hash);
  if identity.installation_id is null then
    raise exception 'receiver is unauthorized' using errcode = '42501';
  end if;
  select * into job from public.message_jobs where id = requested_message_id for update;
  if job.id is null
    or job.assigned_installation_id is null
    or job.assigned_installation_id is distinct from identity.installation_id then
    raise exception 'message is unavailable' using errcode = '42501';
  end if;
  if job.claim_token_hash is null
    or candidate_claim_hash is null
    or job.claim_token_hash is distinct from candidate_claim_hash then
    raise exception 'claim token is invalid or superseded' using errcode = '42501';
  end if;
  if job.imported_at is null then
    if job.claim_expires_at is null or job.claim_expires_at <= now() then
      raise exception 'claim token is expired' using errcode = 'P0002';
    end if;
    update public.message_jobs set status = 'in_receiver_inbox', imported_at = now()
      where id = job.id;
  end if;
  return query select job.id, 'in_receiver_inbox'::text;
end
$$;

create or replace function synapse_private.get_receiver_message(
  candidate_hash bytea, requested_message_id uuid
)
returns table(message_id uuid, public_status text, imported boolean)
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare identity record;
begin
  select * into identity from synapse_private.receiver_identity(candidate_hash);
  if identity.installation_id is null then
    raise exception 'receiver is unauthorized' using errcode = '42501';
  end if;
  return query select job.id, job.status::text, job.imported_at is not null
  from public.message_jobs as job
  where job.id = requested_message_id
    and job.assigned_installation_id = identity.installation_id;
end
$$;

create or replace function synapse_private.record_receiver_events(
  candidate_hash bytea, requested_events jsonb
)
returns table(accepted_event_id uuid)
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare identity record;
declare event record;
declare current_status public.message_public_status;
declare current_claim_hash bytea;
begin
  select * into identity from synapse_private.receiver_identity(candidate_hash);
  if identity.installation_id is null then
    raise exception 'receiver is unauthorized' using errcode = '42501';
  end if;
  for event in select * from jsonb_to_recordset(requested_events) as item(
    event_id uuid, message_id uuid, kind text, occurred_at timestamptz, error_code text
  ) loop
    select job.status, job.claim_token_hash
    into current_status, current_claim_hash
    from public.message_jobs as job
      where job.id = event.message_id
        and job.assigned_installation_id = identity.installation_id
        and job.imported_at is not null for update;
    if current_status is null then
      raise exception 'event message is unavailable' using errcode = '42501';
    end if;
    if event.kind not in ('provisioning', 'delivered', 'needs_attention')
      or event.occurred_at is null
      or event.occurred_at > now() + interval '5 minutes'
      or event.occurred_at < now() - interval '30 days'
      or (event.kind = 'needs_attention' and coalesce(event.error_code, '') !~ '^[a-z0-9_]{1,64}$')
      or (event.kind <> 'needs_attention' and event.error_code is not null) then
      raise exception 'invalid delivery event' using errcode = '22023';
    end if;
    insert into public.message_delivery_events (
      event_id, message_id, receiver_installation_id, claim_token_hash,
      kind, occurred_at, error_code
    ) values (
      event.event_id, event.message_id, identity.installation_id,
      current_claim_hash, event.kind::public.message_delivery_kind,
      event.occurred_at, event.error_code
    ) on conflict (event_id) do nothing;
    if not found then
      if exists (select 1 from public.message_delivery_events as prior
          where prior.event_id = event.event_id
            and prior.message_id = event.message_id
            and prior.receiver_installation_id = identity.installation_id
            and prior.kind::text = event.kind
            and prior.occurred_at = event.occurred_at
            and prior.error_code is not distinct from event.error_code) then
        accepted_event_id := event.event_id;
        return next;
        continue;
      end if;
      raise exception 'event_id conflicts with an existing event' using errcode = '23505';
    end if;
    if event.kind = 'delivered' then
      update public.message_jobs set status = 'delivered', delivered_at = coalesce(delivered_at, event.occurred_at),
        safe_error_code = null where id = event.message_id and status <> 'delivered';
    elsif event.kind = 'needs_attention' and current_status <> 'delivered' then
      update public.message_jobs set status = 'needs_attention', needs_attention_at = event.occurred_at,
        safe_error_code = event.error_code where id = event.message_id;
    elsif event.kind = 'provisioning' and current_status in ('in_receiver_inbox', 'provisioning') then
      update public.message_jobs set status = 'provisioning', provisioning_at = coalesce(provisioning_at, event.occurred_at)
        where id = event.message_id;
    end if;
    accepted_event_id := event.event_id;
    return next;
  end loop;
end
$$;

create or replace function synapse_private.disconnect_receiver(candidate_hash bytea)
returns boolean
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare pairing public.receiver_pairings%rowtype;
declare disconnected_installation_id uuid;
begin
  select candidate_pairing.* into pairing
  from public.receiver_pairings as candidate_pairing
  where candidate_pairing.credential_hash = candidate_hash
  for update;

  select installation.id into disconnected_installation_id
  from public.receiver_installations as installation
  where installation.credential_hash = candidate_hash
  for update;

  if pairing.id is null and disconnected_installation_id is null then
    return false;
  end if;

  if pairing.id is not null and pairing.status <> 'cancelled' then
    update public.receiver_pairings set
      status = 'cancelled', owner_id = null, project_id = null,
      installation_id = null, approved_at = null, cancelled_at = now()
    where id = pairing.id;
  end if;

  if disconnected_installation_id is null then
    return true;
  end if;

  update public.receiver_installations set enabled = false,
    revoked_at = coalesce(revoked_at, now())
  where id = disconnected_installation_id;
  update public.message_jobs set
    status = 'needs_attention',
    safe_error_code = 'receiver_disconnected',
    needs_attention_at = coalesce(needs_attention_at, now())
  where assigned_installation_id = disconnected_installation_id
    and status <> 'delivered';
  return true;
end
$$;

do $$
declare signature text;
begin
  foreach signature in array array[
    'synapse_private.receiver_identity(bytea)',
    'synapse_private.create_receiver_pairing(bytea,bytea)',
    'synapse_private.approve_receiver_pairing(uuid)',
    'synapse_private.complete_receiver_pairing(uuid,bytea)',
    'synapse_private.claim_receiver_messages(bytea,integer)',
    'synapse_private.import_receiver_message(bytea,uuid,bytea)',
    'synapse_private.get_receiver_message(bytea,uuid)',
    'synapse_private.record_receiver_events(bytea,jsonb)',
    'synapse_private.disconnect_receiver(bytea)'
  ] loop
    execute 'revoke all on function ' || signature || ' from public, anon, authenticated';
    execute 'grant execute on function ' || signature || ' to synapse_runtime';
  end loop;
end
$$;
