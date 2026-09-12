-- Reply relationships are separate from transport receipts. Existing messages
-- remain valid, and old receiver clients retain the v1 claim contract.
alter table public.message_jobs
  add column disposition text not null default 'continue'
    check (disposition in ('continue', 'complete', 'needs_user')),
  add column in_reply_to_message_id uuid,
  add column response_error_code text check (response_error_code ~ '^[a-z0-9_]{1,64}$'),
  add constraint message_jobs_id_conversation_unique unique (id, conversation_id),
  add constraint message_jobs_reply_conversation_fk
    foreign key (in_reply_to_message_id, conversation_id)
    references public.message_jobs(id, conversation_id);

create index message_jobs_reply on public.message_jobs(in_reply_to_message_id)
  where in_reply_to_message_id is not null;
create index message_jobs_conversation_sender on public.message_jobs(conversation_id, sender_id, sequence);

create function synapse_private.record_response_failure()
returns trigger language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  if new.kind = 'needs_attention' and new.error_code in ('reply_missing', 'reply_interrupted', 'execution_failed') then
    update public.message_jobs set response_error_code = new.error_code where id = new.message_id;
  end if;
  return new;
end
$$;
revoke all on function synapse_private.record_response_failure() from public, anon, authenticated, synapse_runtime;
create trigger message_response_failure after insert on public.message_delivery_events
for each row execute function synapse_private.record_response_failure();

-- Reveal public names only, without widening the owner-only profiles policy
-- (profiles also contains private account data).
create function synapse_private.conversation_participants(selected_id uuid)
returns jsonb language sql stable security definer set search_path = '' set row_security = off
as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', profile.id, 'username', profile.username)
    order by profile.id), '[]'::jsonb)
  from public.message_conversations conversation
  join public.profiles profile on profile.id in (conversation.participant_one_id, conversation.participant_two_id)
  where conversation.id = selected_id
    and synapse_private.current_user_id() in (conversation.participant_one_id, conversation.participant_two_id)
$$;

create function synapse_private.enqueue_conversation_message(
  requested_username text, requested_message text, requested_id uuid,
  selected_conversation_id uuid default null,
  reply_to uuid default null, requested_disposition text default 'continue'
)
returns table (
  message_id uuid, conversation_id uuid, message_sequence bigint,
  recipient_user_id uuid, recipient_username text, public_status text,
  was_idempotent boolean, queued_at timestamptz
)
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  actor uuid := synapse_private.current_user_id();
  original public.message_jobs%rowtype;
  existing public.message_jobs%rowtype;
  sent record;
begin
  if actor is null then
    raise exception 'authenticated identity is required' using errcode = '42501';
  end if;
  if requested_id is null or requested_disposition is null or
      requested_disposition not in ('continue', 'complete', 'needs_user') then
    raise exception 'invalid message disposition or request_id' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':' || requested_id::text, 0));
  if reply_to is not null then
    select * into original from public.message_jobs where id = reply_to;
    if original.id is null or original.recipient_id <> actor then
      raise exception 'reply message is unavailable' using errcode = '42501';
    end if;
    if selected_conversation_id is not null and selected_conversation_id <> original.conversation_id then
      raise exception 'reply conversation does not match' using errcode = '22023';
    end if;
    selected_conversation_id := original.conversation_id;
    select username::text into requested_username from public.profiles where id = original.sender_id;
  end if;
  select * into existing from public.message_jobs
    where sender_id = actor and sender_request_id = requested_id;
  if found and (existing.disposition is distinct from requested_disposition
      or existing.in_reply_to_message_id is distinct from reply_to) then
    raise exception 'request_id was already used with different message parameters' using errcode = '23505';
  end if;
  select * into sent from synapse_private.enqueue_message(
    requested_username, requested_message, requested_id, selected_conversation_id);
  if reply_to is not null then
    update public.message_jobs set response_error_code = null where id = reply_to;
  end if;
  if not sent.was_idempotent then
    update public.message_jobs set disposition = requested_disposition,
      in_reply_to_message_id = reply_to where id = sent.message_id;
  end if;
  return query select sent.message_id, sent.conversation_id, sent.message_sequence,
    sent.recipient_user_id, sent.recipient_username, sent.public_status,
    sent.was_idempotent, sent.queued_at;
end
$$;

create function synapse_private.claim_receiver_messages_v2(candidate_hash bytea, requested_limit integer)
returns table (
  installation_id uuid, user_id uuid, username text, project_id uuid,
  project_alias text, receiver_expires_at timestamptz, message_id uuid,
  conversation_id uuid, message_sequence bigint, sender_id uuid,
  sender_username text, message text, content_hash text, claim_token text,
  lease_expires_at timestamptz, disposition text, in_reply_to_message_id uuid,
  recipient_origin_request_id uuid
)
language sql security definer set search_path = '' set row_security = off
as $$
  select claimed.*, job.disposition, job.in_reply_to_message_id,
    (select origin.sender_request_id from public.message_jobs origin
      where origin.conversation_id = claimed.conversation_id
        and origin.sender_id = claimed.user_id
      order by origin.sequence limit 1)
  from synapse_private.claim_receiver_messages(candidate_hash, requested_limit) claimed
  join public.message_jobs job on job.id = claimed.message_id
$$;

revoke all on function synapse_private.enqueue_conversation_message(text,text,uuid,uuid,uuid,text),
  synapse_private.claim_receiver_messages_v2(bytea,integer),
  synapse_private.conversation_participants(uuid) from public, anon, authenticated;
grant execute on function synapse_private.enqueue_conversation_message(text,text,uuid,uuid,uuid,text),
  synapse_private.claim_receiver_messages_v2(bytea,integer),
  synapse_private.conversation_participants(uuid) to synapse_runtime;
