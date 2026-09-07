-- Normalized accepted claims; the capture revision remains the source authority.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.projects'::regclass
    and conname = 'projects_id_owner_unique') then
    alter table public.projects add constraint projects_id_owner_unique unique (id, owner_id);
  end if;
end;
$$;

create table synapse_private.memory_ledger_projects (
  owner_id uuid not null,
  project_id uuid not null,
  generation bigint not null default 0 check (generation >= 0),
  core_version text not null,
  projection_version text not null,
  primary key (owner_id, project_id),
  foreign key (project_id, owner_id) references public.projects(id, owner_id)
);

create table synapse_private.memory_ledger_sources (
  owner_id uuid not null,
  project_id uuid not null,
  revision_id uuid not null,
  generation bigint not null check (generation > 0),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null,
  audit jsonb not null check (octet_length(audit::text) <= 16384),
  primary key (owner_id, project_id, revision_id),
  unique (owner_id, project_id, generation),
  foreign key (owner_id, project_id) references synapse_private.memory_ledger_projects,
  foreign key (revision_id, owner_id, project_id)
    references public.memory_revisions(id, owner_id, project_id)
);

create table synapse_private.memory_claims (
  owner_id uuid not null,
  project_id uuid not null,
  id text not null,
  source_revision_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  ref text not null check (ref ~ '^c[1-9][0-9]*$'),
  subject text not null check (length(subject) > 0),
  aspect text not null check (length(aspect) > 0),
  scope text not null check (length(scope) > 0),
  title text not null check (length(title) > 0),
  assertion text not null check (length(assertion) > 0),
  kind text not null check (kind in ('fact','decision','procedure','open_question','reference','change')),
  status text not null check (status in ('active','disputed','historical')),
  topic text not null,
  subtopic text not null,
  observed_at timestamptz not null,
  recorded_at timestamptz not null,
  primary key (owner_id, project_id, id),
  unique (owner_id, project_id, source_revision_id, ordinal),
  unique (owner_id, project_id, source_revision_id, ref),
  foreign key (owner_id, project_id, source_revision_id)
    references synapse_private.memory_ledger_sources(owner_id, project_id, revision_id)
);

create table synapse_private.memory_evidence (
  owner_id uuid not null,
  project_id uuid not null,
  segment_id text not null,
  revision_id uuid not null,
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset > start_offset),
  quote text not null check (length(quote) > 0),
  primary key (owner_id, project_id, segment_id),
  unique (owner_id, project_id, revision_id, segment_id),
  foreign key (owner_id, project_id, revision_id)
    references synapse_private.memory_ledger_sources(owner_id, project_id, revision_id)
);

create table synapse_private.memory_claim_evidence (
  owner_id uuid not null,
  project_id uuid not null,
  claim_id text not null,
  ordinal integer not null check (ordinal >= 0),
  segment_id text not null,
  primary key (owner_id, project_id, claim_id, ordinal),
  unique (owner_id, project_id, claim_id, segment_id),
  foreign key (owner_id, project_id, claim_id) references synapse_private.memory_claims,
  foreign key (owner_id, project_id, segment_id) references synapse_private.memory_evidence
);

create table synapse_private.memory_claim_relations (
  owner_id uuid not null,
  project_id uuid not null,
  id text not null,
  source_revision_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  from_claim_id text not null,
  to_claim_id text not null check (to_claim_id <> from_claim_id),
  type text not null check (type in ('equivalent','supersedes','resolves','conflicts')),
  reason text not null check (length(reason) > 0),
  introduced_in bigint not null check (introduced_in > 0),
  primary key (owner_id, project_id, id),
  unique (owner_id, project_id, source_revision_id, ordinal),
  foreign key (owner_id, project_id, source_revision_id)
    references synapse_private.memory_ledger_sources(owner_id, project_id, revision_id),
  foreign key (owner_id, project_id, from_claim_id) references synapse_private.memory_claims,
  foreign key (owner_id, project_id, to_claim_id) references synapse_private.memory_claims,
  foreign key (owner_id, project_id, introduced_in)
    references synapse_private.memory_ledger_sources(owner_id, project_id, generation)
);

create table synapse_private.memory_segment_coverage (
  owner_id uuid not null,
  project_id uuid not null,
  revision_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  segment_id text not null,
  disposition text not null check (disposition in ('claims','context','untrusted','boilerplate')),
  reason text not null check (length(reason) > 0),
  primary key (owner_id, project_id, revision_id, segment_id),
  unique (owner_id, project_id, revision_id, ordinal),
  foreign key (owner_id, project_id, revision_id, segment_id)
    references synapse_private.memory_evidence(owner_id, project_id, revision_id, segment_id)
);

create table synapse_private.memory_projection_topics (
  owner_id uuid not null,
  project_id uuid not null,
  id text not null,
  ordinal integer not null check (ordinal >= 0),
  parent_id text,
  title text not null,
  summary text not null,
  index_text text not null,
  generation bigint not null,
  primary key (owner_id, project_id, id),
  foreign key (owner_id, project_id, parent_id)
    references synapse_private.memory_projection_topics deferrable initially deferred,
  foreign key (owner_id, project_id, generation)
    references synapse_private.memory_ledger_sources(owner_id, project_id, generation)
);

create table synapse_private.memory_projection_notes (
  owner_id uuid not null,
  project_id uuid not null,
  id text not null,
  ordinal integer not null check (ordinal >= 0),
  key text not null,
  kind text not null,
  primary_topic_id text not null,
  title text not null,
  body text not null,
  status text not null check (status in ('active','resolved','disputed')),
  observed_at timestamptz,
  generation bigint not null,
  primary key (owner_id, project_id, id),
  foreign key (owner_id, project_id, primary_topic_id)
    references synapse_private.memory_projection_topics,
  foreign key (owner_id, project_id, generation)
    references synapse_private.memory_ledger_sources(owner_id, project_id, generation)
);

create table synapse_private.memory_projection_note_claims (
  owner_id uuid not null,
  project_id uuid not null,
  note_id text not null,
  ordinal integer not null check (ordinal >= 0),
  claim_id text not null,
  primary key (owner_id, project_id, note_id, ordinal),
  unique (owner_id, project_id, claim_id),
  foreign key (owner_id, project_id, note_id) references synapse_private.memory_projection_notes,
  foreign key (owner_id, project_id, claim_id) references synapse_private.memory_claims
);

create table synapse_private.memory_projection_note_evidence (
  owner_id uuid not null,
  project_id uuid not null,
  note_id text not null,
  ordinal integer not null check (ordinal >= 0),
  segment_id text not null,
  primary key (owner_id, project_id, note_id, ordinal),
  unique (owner_id, project_id, note_id, segment_id),
  foreign key (owner_id, project_id, note_id) references synapse_private.memory_projection_notes,
  foreign key (owner_id, project_id, segment_id) references synapse_private.memory_evidence
);

create table synapse_private.memory_projection_edges (
  owner_id uuid not null,
  project_id uuid not null,
  id text not null,
  ordinal integer not null check (ordinal >= 0),
  from_note_id text not null,
  to_note_id text not null,
  type text not null check (type in ('contradicts','supports')),
  reason text not null,
  relation_id text not null,
  generation bigint not null,
  primary key (owner_id, project_id, id),
  foreign key (owner_id, project_id, from_note_id) references synapse_private.memory_projection_notes,
  foreign key (owner_id, project_id, to_note_id) references synapse_private.memory_projection_notes,
  foreign key (owner_id, project_id, relation_id) references synapse_private.memory_claim_relations,
  foreign key (owner_id, project_id, generation)
    references synapse_private.memory_ledger_sources(owner_id, project_id, generation)
);

create function synapse_private.reject_memory_ledger_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Accepted memory ledger entries are immutable' using errcode = '23514';
end;
$$;
revoke all on function synapse_private.reject_memory_ledger_mutation() from public;

-- Evidence/source/claim history is insert-only even for accidental privileged writes.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'memory_ledger_sources','memory_claims','memory_evidence',
    'memory_claim_evidence','memory_claim_relations','memory_segment_coverage'
  ] loop
    execute format('create trigger immutable_memory_ledger before update or delete on synapse_private.%I
      for each row execute function synapse_private.reject_memory_ledger_mutation()', table_name);
    execute format('grant select, insert on synapse_private.%I to synapse_memory_worker', table_name);
  end loop;
  foreach table_name in array array[
    'memory_ledger_projects','memory_projection_topics','memory_projection_notes',
    'memory_projection_note_claims','memory_projection_note_evidence','memory_projection_edges'
  ] loop
    execute format('grant select, insert, update, delete on synapse_private.%I to synapse_memory_worker', table_name);
  end loop;
  foreach table_name in array array[
    'memory_ledger_projects','memory_ledger_sources','memory_claims','memory_evidence',
    'memory_claim_evidence','memory_claim_relations','memory_segment_coverage',
    'memory_projection_topics','memory_projection_notes','memory_projection_note_claims',
    'memory_projection_note_evidence','memory_projection_edges'
  ] loop
    execute format('alter table synapse_private.%I enable row level security', table_name);
    execute format('alter table synapse_private.%I force row level security', table_name);
    execute format('revoke all on synapse_private.%I from public, anon, authenticated', table_name);
    execute format('grant select on synapse_private.%I to synapse_runtime', table_name);
    execute format('create policy memory_owner_read on synapse_private.%I for select to synapse_runtime
      using (owner_id = synapse_private.current_user_id())', table_name);
    execute format('create policy memory_worker_scope on synapse_private.%I for all to synapse_memory_worker
      using (owner_id = synapse_private.current_user_id()
        and project_id = nullif(current_setting(''app.current_project_id'', true), '''')::uuid)
      with check (owner_id = synapse_private.current_user_id()
        and project_id = nullif(current_setting(''app.current_project_id'', true), '''')::uuid)', table_name);
  end loop;
end;
$$;
