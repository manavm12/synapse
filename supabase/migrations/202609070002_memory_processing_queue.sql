do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'synapse_memory_worker'
  ) then
    create role synapse_memory_worker
      nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$$;

create type synapse_private.memory_processing_status as enum (
  'pending',
  'processing',
  'succeeded',
  'failed'
);

alter table public.memory_revisions
  add constraint memory_revisions_owner_project_identity
  unique (id, owner_id, project_id);

create table synapse_private.memory_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  revision_id uuid not null,
  processor_version integer not null,
  status synapse_private.memory_processing_status not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  leased_by text,
  lease_token uuid,
  lease_fence bigint,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint memory_processing_jobs_revision_fk foreign key (
    revision_id, owner_id, project_id
  ) references public.memory_revisions(id, owner_id, project_id) on delete cascade,
  constraint memory_processing_jobs_processor_version_positive check (
    processor_version > 0
  ),
  constraint memory_processing_jobs_attempts_valid check (
    attempt_count >= 0 and max_attempts between 1 and 100
  ),
  constraint memory_processing_jobs_worker_length check (
    leased_by is null or char_length(leased_by) between 1 and 200
  ),
  constraint memory_processing_jobs_error_length check (
    last_error is null or char_length(last_error) <= 4000
  ),
  constraint memory_processing_jobs_lease_shape check (
    (
      status = 'processing'
      and leased_by is not null
      and lease_token is not null
      and lease_fence is not null
      and lease_expires_at is not null
      and completed_at is null
    ) or (
      status <> 'processing'
      and leased_by is null
      and lease_token is null
      and lease_fence is null
      and lease_expires_at is null
    )
  ),
  constraint memory_processing_jobs_completion_shape check (
    (status = 'succeeded' and completed_at is not null)
    or (status <> 'succeeded' and completed_at is null)
  ),
  unique (revision_id, processor_version)
);

create index memory_processing_jobs_ready
  on synapse_private.memory_processing_jobs(available_at, created_at)
  where status = 'pending';
create index memory_processing_jobs_project_status
  on synapse_private.memory_processing_jobs(project_id, status);

create table synapse_private.memory_processing_project_leases (
  project_id uuid primary key references public.projects(id) on delete cascade,
  fence bigint not null default 0,
  lease_token uuid,
  leased_by text,
  lease_expires_at timestamptz,
  constraint memory_processing_project_leases_fence_nonnegative check (
    fence >= 0
  ),
  constraint memory_processing_project_leases_worker_length check (
    leased_by is null or char_length(leased_by) between 1 and 200
  ),
  constraint memory_processing_project_leases_shape check (
    (lease_token is null and leased_by is null and lease_expires_at is null)
    or (lease_token is not null and leased_by is not null and lease_expires_at is not null)
  )
);

create trigger memory_processing_jobs_set_updated_at
before update on synapse_private.memory_processing_jobs
for each row execute function synapse_private.set_updated_at();

create or replace function synapse_private.enqueue_memory_processing(
  accepted_revision_id uuid,
  accepted_processor_version integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued_job_id uuid;
begin
  if accepted_processor_version <= 0 then
    raise exception 'processor version must be positive' using errcode = '22023';
  end if;

  insert into synapse_private.memory_processing_jobs (
    owner_id, project_id, revision_id, processor_version
  )
  select revision.owner_id, revision.project_id, revision.id,
         accepted_processor_version
  from public.memory_revisions as revision
  where revision.id = accepted_revision_id
    and revision.owner_id = synapse_private.current_user_id()
  on conflict (revision_id, processor_version) do nothing
  returning id into queued_job_id;

  if queued_job_id is null and not exists (
    select 1
    from synapse_private.memory_processing_jobs as job
    where job.revision_id = accepted_revision_id
      and job.processor_version = accepted_processor_version
      and job.owner_id = synapse_private.current_user_id()
  ) then
    raise exception 'accepted memory revision is not available to this user'
      using errcode = '42501';
  end if;

  return coalesce(
    queued_job_id,
    (
      select job.id
      from synapse_private.memory_processing_jobs as job
      where job.revision_id = accepted_revision_id
        and job.processor_version = accepted_processor_version
        and job.owner_id = synapse_private.current_user_id()
    )
  );
end
$$;

revoke all on function synapse_private.enqueue_memory_processing(uuid, integer)
  from public;
grant execute on function synapse_private.enqueue_memory_processing(uuid, integer)
  to synapse_runtime;

grant usage on schema synapse_private to synapse_memory_worker;
grant select, insert, update on synapse_private.memory_processing_jobs
  to synapse_memory_worker;
grant select, insert, update on synapse_private.memory_processing_project_leases
  to synapse_memory_worker;
grant select on public.memory_revisions, public.memory_nodes,
  public.agent_sessions, public.projects to synapse_memory_worker;

create policy projects_memory_worker_select on public.projects
  for select to synapse_memory_worker using (true);
create policy memory_nodes_memory_worker_select on public.memory_nodes
  for select to synapse_memory_worker using (true);
create policy memory_revisions_memory_worker_select on public.memory_revisions
  for select to synapse_memory_worker using (true);
create policy agent_sessions_memory_worker_select on public.agent_sessions
  for select to synapse_memory_worker using (true);
