-- Message-specific context. Receiver credentials never gain general memory access.
create table synapse_private.message_memory_contexts (
  message_id uuid primary key,
  owner_id uuid not null,
  project_id uuid not null,
  installation_id uuid not null references public.receiver_installations(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','working','complete')),
  requested_at timestamptz not null default now(),
  deadline_at timestamptz not null default now() + interval '30 seconds',
  lease_token uuid,
  result jsonb check (octet_length(result::text) <= 16384),
  foreign key (message_id, owner_id, project_id)
    references public.message_jobs(id, recipient_id, recipient_project_id) on delete cascade
);
alter table synapse_private.message_memory_contexts enable row level security;
alter table synapse_private.message_memory_contexts force row level security;
revoke all on synapse_private.message_memory_contexts from public, anon, authenticated, synapse_runtime, synapse_memory_worker;
create index message_memory_pending on synapse_private.message_memory_contexts(requested_at) where state='pending';

create function synapse_private.prepare_message_memory(candidate_hash bytea, requested_message_id uuid)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare identity record; job public.message_jobs%rowtype; context synapse_private.message_memory_contexts%rowtype; generation bigint;
begin
  select * into identity from synapse_private.receiver_identity(candidate_hash);
  if identity.installation_id is null then raise exception 'receiver unauthorized' using errcode='42501'; end if;
  select * into job from public.message_jobs where id=requested_message_id;
  if job.id is null or job.recipient_id<>identity.user_id or job.recipient_project_id<>identity.project_id
    or job.assigned_installation_id is distinct from identity.installation_id or job.imported_at is null then
    raise exception 'message unavailable' using errcode='42501';
  end if;
  insert into synapse_private.message_memory_contexts(message_id,owner_id,project_id,installation_id)
    values(job.id,job.recipient_id,job.recipient_project_id,identity.installation_id) on conflict do nothing;
  select * into context from synapse_private.message_memory_contexts where message_id=job.id;
  if context.installation_id<>identity.installation_id then raise exception 'message unavailable' using errcode='42501'; end if;
  if context.state='complete' then
    select p.generation into generation from synapse_private.memory_ledger_projects p where p.owner_id=job.recipient_id and p.project_id=job.recipient_project_id;
    if context.result->>'generation' is not null and (context.result->>'generation')::bigint <> coalesce(generation,0) then
      return jsonb_build_object('status','unavailable','gaps',jsonb_build_array('generation_changed'));
    end if;
    return context.result || jsonb_build_object('message_id',job.id,'recipient_id',job.recipient_id,'project_id',job.recipient_project_id,'installation_id',identity.installation_id,'content_hash',job.content_hash);
  end if;
  if context.deadline_at <= now() then
    return jsonb_build_object('status','unavailable','gaps',jsonb_build_array('deadline'));
  end if;
  return jsonb_build_object('status','pending');
end $$;

create function synapse_private.claim_message_memory()
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare context synapse_private.message_memory_contexts%rowtype; job public.message_jobs%rowtype; history jsonb;
begin
  select c.* into context from synapse_private.message_memory_contexts c
    join public.receiver_installations i on i.id=c.installation_id
    join public.profiles p on p.id=c.owner_id
    join public.message_jobs m on m.id=c.message_id and m.assigned_installation_id=c.installation_id
    where c.state='pending' and c.deadline_at>now() and i.enabled and i.revoked_at is null and i.expires_at>now() and p.status='active'
    order by c.requested_at for update of c skip locked limit 1;
  if not found then return null; end if;
  update synapse_private.message_memory_contexts set state='working',lease_token=gen_random_uuid()
    where message_id=context.message_id returning * into context;
  select * into job from public.message_jobs where id=context.message_id;
  select coalesce(jsonb_agg(jsonb_build_object('sender',h.sender_id,'message',h.message) order by h.sequence),'[]') into history
    from (select m.sender_id,m.message,m.sequence from public.message_jobs m
      where m.conversation_id=job.conversation_id and m.sequence<job.sequence
        and (m.sender_id=job.recipient_id or m.recipient_id=job.recipient_id)
      order by m.sequence desc limit 4) h;
  return jsonb_build_object('message_id',job.id,'identity',jsonb_build_object('userId',job.recipient_id,'projectId',job.recipient_project_id),
    'message',job.message,'history',history,'lease_token',context.lease_token,'deadline_at',context.deadline_at);
end $$;

create function synapse_private.finish_message_memory(requested_message_id uuid, token uuid, bundle jsonb)
returns boolean language plpgsql security definer set search_path='' set row_security=off as $$
declare updated integer;
begin
  if bundle->>'status' not in ('ready','no_match','partial','unavailable') or bundle->>'status' is null then
    raise exception 'invalid context status' using errcode='22023';
  end if;
  update synapse_private.message_memory_contexts c set state='complete', result=bundle
    where c.message_id=requested_message_id and c.lease_token=token and c.state='working' and c.deadline_at>now()
      and exists(select 1 from public.receiver_installations i join public.profiles p on p.id=i.owner_id
        where i.id=c.installation_id and i.enabled and i.revoked_at is null and i.expires_at>now() and p.status='active');
  get diagnostics updated=row_count;
  return updated=1;
end $$;

revoke all on function synapse_private.prepare_message_memory(bytea,uuid) from public,anon,authenticated;
revoke all on function synapse_private.claim_message_memory() from public,anon,authenticated;
revoke all on function synapse_private.finish_message_memory(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function synapse_private.prepare_message_memory(bytea,uuid) to synapse_runtime;
grant execute on function synapse_private.claim_message_memory() to synapse_memory_worker;
grant execute on function synapse_private.finish_message_memory(uuid,uuid,jsonb) to synapse_memory_worker;
