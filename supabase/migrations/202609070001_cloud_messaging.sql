create type public.message_public_status as enum (
  'queued',
  'in_receiver_inbox',
  'provisioning',
  'delivered',
  'needs_attention'
);

create table public.message_conversations (
  id uuid primary key default gen_random_uuid(),
  participant_one_id uuid not null references public.profiles(id) on delete cascade,
  participant_two_id uuid not null references public.profiles(id) on delete cascade,
  next_sequence bigint not null default 1,
  created_at timestamptz not null default now(),
  constraint message_conversations_distinct_participants check (
    participant_one_id < participant_two_id
  ),
  constraint message_conversations_sequence_positive check (next_sequence > 0),
  unique (id, participant_one_id, participant_two_id)
);

create table public.message_jobs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.message_conversations(id) on delete cascade,
  sequence bigint not null,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  recipient_project_id uuid not null references public.projects(id) on delete cascade,
  requested_conversation_id uuid,
  sender_request_id uuid not null,
  message text not null,
  content_hash text not null,
  status public.message_public_status not null default 'queued',
  safe_error_code text,
  queued_at timestamptz not null default now(),
  imported_at timestamptz,
  provisioning_at timestamptz,
  delivered_at timestamptz,
  needs_attention_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint message_jobs_distinct_participants check (sender_id <> recipient_id),
  constraint message_jobs_sequence_positive check (sequence > 0),
  constraint message_jobs_body_size check (
    octet_length(message) between 1 and 61440
  ),
  constraint message_jobs_hash_format check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint message_jobs_error_code_safe check (
    safe_error_code is null or safe_error_code ~ '^[a-z0-9_]{1,64}$'
  ),
  unique (sender_id, sender_request_id),
  unique (conversation_id, sequence),
  unique (id, recipient_id, recipient_project_id)
);

create index message_jobs_recipient_queue
  on public.message_jobs(recipient_id, recipient_project_id, queued_at, sequence)
  where status = 'queued';
create index message_jobs_sender_created
  on public.message_jobs(sender_id, queued_at desc, id desc);
create index message_jobs_recipient_created
  on public.message_jobs(recipient_id, queued_at desc, id desc);

create trigger message_jobs_set_updated_at
before update on public.message_jobs
for each row execute function synapse_private.set_updated_at();

alter table public.message_conversations enable row level security;
alter table public.message_conversations force row level security;
alter table public.message_jobs enable row level security;
alter table public.message_jobs force row level security;

create policy message_conversations_participant_select
  on public.message_conversations for select to synapse_runtime
  using (
    synapse_private.current_user_id() in (participant_one_id, participant_two_id)
  );
create policy message_jobs_participant_select
  on public.message_jobs for select to synapse_runtime
  using (synapse_private.current_user_id() in (sender_id, recipient_id));

revoke all on public.message_conversations, public.message_jobs
  from public, anon, authenticated;
grant select on public.message_conversations, public.message_jobs
  to synapse_runtime;

create or replace function synapse_private.enqueue_message(
  requested_username text,
  requested_message text,
  requested_id uuid,
  selected_conversation_id uuid default null
)
returns table (
  message_id uuid,
  conversation_id uuid,
  message_sequence bigint,
  recipient_user_id uuid,
  recipient_username text,
  public_status text,
  was_idempotent boolean,
  queued_at timestamptz
)
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  actor_id uuid := synapse_private.current_user_id();
  normalized_username text := lower(regexp_replace(btrim(requested_username), '^@', ''));
  target_id uuid;
  target_project_id uuid;
  target_username text;
  existing public.message_jobs%rowtype;
  conversation public.message_conversations%rowtype;
  participant_one uuid;
  participant_two uuid;
  allocated_sequence bigint;
  body_hash text;
  hourly_limit integer := 100;
  pending_limit integer := 1000;
  new_message_id uuid;
  new_queued_at timestamptz;
begin
  if actor_id is null then
    raise exception 'authenticated identity is required' using errcode = '42501';
  end if;
  if normalized_username !~ '^[a-z][a-z0-9_-]{2,31}$' then
    raise exception 'recipient is unavailable' using errcode = 'P0002';
  end if;
  if requested_message is null or octet_length(requested_message) not between 1 and 61440 then
    raise exception 'message must be between 1 byte and 60 KiB' using errcode = '22001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(actor_id::text || ':' || requested_id::text, 0));

  select job.* into existing
  from public.message_jobs as job
  where job.sender_id = actor_id and job.sender_request_id = requested_id;

  if found then
    select profile.username::text into target_username
    from public.profiles as profile where profile.id = existing.recipient_id;
    if target_username is distinct from normalized_username
      or existing.requested_conversation_id is distinct from selected_conversation_id
      or existing.message is distinct from requested_message then
      raise exception 'request_id was already used with different message parameters'
        using errcode = '23505', constraint = 'message_jobs_sender_request_id_key';
    end if;
    return query select existing.id, existing.conversation_id, existing.sequence,
      existing.recipient_id, target_username, existing.status::text, true,
      existing.queued_at;
    return;
  end if;

  if not exists (
    select 1 from public.profiles as actor
    join public.projects as actor_project on actor_project.owner_id = actor.id
    where actor.id = actor_id and actor.status = 'active'
  ) then
    raise exception 'sender is inactive' using errcode = '42501';
  end if;

  select profile.id, project.id, profile.username::text
  into target_id, target_project_id, target_username
  from public.profiles as profile
  join public.projects as project on project.owner_id = profile.id
  where profile.username = normalized_username and profile.status = 'active';
  if target_id is null or target_id = actor_id then
    raise exception 'recipient is unavailable' using errcode = 'P0002';
  end if;

  -- Serialize both quota scopes in UUID order. This prevents concurrent sends
  -- from overrunning either distributed counter and avoids A->B/B->A deadlocks.
  perform pg_advisory_xact_lock(hashtextextended(
    'message-quota:' || least(actor_id, target_id)::text, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'message-quota:' || greatest(actor_id, target_id)::text, 0
  ));

  select coalesce((select value::integer from public.app_config where key = 'message_sender_hourly_limit'), 100),
         coalesce((select value::integer from public.app_config where key = 'message_recipient_pending_limit'), 1000)
  into hourly_limit, pending_limit;
  if (select count(*) from public.message_jobs as recent where recent.sender_id = actor_id
      and recent.queued_at > now() - interval '1 hour') >= greatest(hourly_limit, 1) then
    raise exception 'sender rate limit exceeded' using errcode = '54000';
  end if;
  if (select count(*) from public.message_jobs as pending where pending.recipient_id = target_id
      and pending.status in ('queued', 'in_receiver_inbox', 'provisioning', 'needs_attention'))
      >= greatest(pending_limit, 1) then
    raise exception 'recipient inbox is full' using errcode = '54000';
  end if;

  if selected_conversation_id is null then
    participant_one := least(actor_id, target_id);
    participant_two := greatest(actor_id, target_id);
    insert into public.message_conversations (participant_one_id, participant_two_id)
    values (participant_one, participant_two)
    returning * into conversation;
  else
    select item.* into conversation
    from public.message_conversations as item
    where item.id = selected_conversation_id
    for update;
    if conversation.id is null
      or not (actor_id in (conversation.participant_one_id, conversation.participant_two_id))
      or not (target_id in (conversation.participant_one_id, conversation.participant_two_id)) then
      raise exception 'conversation is unavailable' using errcode = '42501';
    end if;
  end if;

  if selected_conversation_id is null then
    -- The insert already holds the new row lock.
    allocated_sequence := conversation.next_sequence;
  else
    allocated_sequence := conversation.next_sequence;
  end if;
  update public.message_conversations
  set next_sequence = next_sequence + 1
  where id = conversation.id;

  body_hash := encode(extensions.digest(convert_to(requested_message, 'UTF8'), 'sha256'), 'hex');
  insert into public.message_jobs (
    conversation_id, sequence, sender_id, recipient_id, recipient_project_id,
    requested_conversation_id, sender_request_id, message, content_hash
  ) values (
    conversation.id, allocated_sequence, actor_id, target_id, target_project_id,
    selected_conversation_id, requested_id, requested_message, body_hash
  ) returning id, message_jobs.queued_at into new_message_id, new_queued_at;

  insert into public.audit_events (
    owner_id, oauth_client_id, action, target_type, target_id, request_id, metadata
  ) values (
    actor_id, null, 'message.enqueued', 'message_job', new_message_id,
    requested_id, jsonb_build_object(
      'conversation_id', conversation.id,
      'recipient_id', target_id,
      'sequence', allocated_sequence,
      'content_hash', body_hash
    )
  );

  return query select new_message_id, conversation.id, allocated_sequence,
    target_id, target_username, 'queued'::text, false, new_queued_at;
end
$$;

revoke all on function synapse_private.enqueue_message(text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function synapse_private.enqueue_message(text, text, uuid, uuid)
  to synapse_runtime;
