create schema if not exists extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'synapse_runtime') then
    create role synapse_runtime
      nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$$;

create schema if not exists synapse_private;
revoke all on schema synapse_private from public;
grant usage on schema synapse_private to synapse_runtime;

create type public.profile_status as enum ('invited', 'active', 'disabled');
create type public.memory_node_kind as enum ('root', 'topic', 'session');
create type public.capture_reason as enum ('turn_checkpoint', 'compaction', 'manual');
create type public.invite_status as enum ('pending', 'sent', 'accepted', 'failed', 'expired');

create table public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username extensions.citext not null unique,
  email extensions.citext not null unique,
  status public.profile_status not null default 'invited',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format check (
    username::text = lower(username::text)
    and username::text ~ '^[a-z][a-z0-9_-]{2,31}$'
  ),
  constraint profiles_email_normalized check (email::text = lower(email::text))
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles(id) on delete cascade,
  alias extensions.citext not null,
  display_name text not null,
  checkpoint_interval integer not null default 15,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_alias_format check (
    alias::text = lower(alias::text)
    and alias::text ~ '^[a-z][a-z0-9_-]{1,62}$'
  ),
  constraint projects_checkpoint_interval check (
    checkpoint_interval between 1 and 1000
  ),
  constraint projects_display_name_length check (
    char_length(display_name) between 1 and 100
  )
);

create table public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  client_session_id text not null,
  runtime text not null default 'codex',
  oauth_client_id text,
  auth_method text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint agent_sessions_client_id_length check (
    char_length(client_session_id) between 1 and 200
  ),
  constraint agent_sessions_runtime_length check (
    char_length(runtime) between 1 and 50
  ),
  constraint agent_sessions_auth_method_length check (
    char_length(auth_method) between 1 and 50
  ),
  unique (owner_id, client_session_id),
  unique (id, owner_id, project_id)
);

create table public.memory_nodes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  parent_node_id uuid,
  kind public.memory_node_kind not null,
  source_session_id text,
  title text not null,
  summary text not null default '',
  markdown text not null default '',
  revision integer not null default 0,
  content_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id, project_id),
  constraint memory_nodes_parent_fk foreign key (
    parent_node_id, owner_id, project_id
  ) references public.memory_nodes(id, owner_id, project_id) on delete cascade,
  constraint memory_nodes_title_length check (char_length(title) between 1 and 200),
  constraint memory_nodes_summary_length check (char_length(summary) <= 2000),
  constraint memory_nodes_markdown_length check (octet_length(markdown) <= 65536),
  constraint memory_nodes_revision_positive check (revision >= 0),
  constraint memory_nodes_hash_format check (
    content_hash is null or content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint memory_nodes_source_shape check (
    (kind = 'session' and source_session_id is not null and parent_node_id is not null)
    or (kind = 'root' and source_session_id is null and parent_node_id is null)
    or (kind = 'topic' and source_session_id is null and parent_node_id is not null)
  )
);

create unique index memory_nodes_one_root_per_project
  on public.memory_nodes(project_id)
  where kind = 'root';
create unique index memory_nodes_one_session_per_project
  on public.memory_nodes(project_id, source_session_id)
  where kind = 'session';

create table public.memory_revisions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  node_id uuid not null,
  author_session_id uuid not null,
  capture_id uuid not null unique,
  capture_reason public.capture_reason not null,
  revision integer not null,
  title text not null,
  summary text not null,
  markdown text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint memory_revisions_node_fk foreign key (
    node_id, owner_id, project_id
  ) references public.memory_nodes(id, owner_id, project_id) on delete cascade,
  constraint memory_revisions_session_fk foreign key (
    author_session_id, owner_id, project_id
  ) references public.agent_sessions(id, owner_id, project_id) on delete restrict,
  constraint memory_revisions_revision_positive check (revision > 0),
  constraint memory_revisions_title_length check (char_length(title) between 1 and 200),
  constraint memory_revisions_summary_length check (char_length(summary) <= 2000),
  constraint memory_revisions_markdown_length check (octet_length(markdown) <= 65536),
  constraint memory_revisions_hash_format check (content_hash ~ '^[0-9a-f]{64}$'),
  unique (node_id, revision)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  actor_session_id uuid,
  oauth_client_id text,
  action text not null,
  target_type text not null,
  target_id uuid,
  request_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_events_session_fk foreign key (actor_session_id)
    references public.agent_sessions(id) on delete set null,
  constraint audit_events_action_length check (char_length(action) between 1 and 100),
  constraint audit_events_target_length check (char_length(target_type) between 1 and 50),
  constraint audit_events_safe_metadata_size check (
    octet_length(metadata::text) <= 4096
  )
);

create index audit_events_owner_created
  on public.audit_events(owner_id, created_at desc);

create table public.development_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  label text not null,
  token_prefix text not null,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint development_tokens_label_length check (char_length(label) between 1 and 100),
  constraint development_tokens_prefix check (token_prefix like 'syn_dev_%'),
  constraint development_tokens_hash_length check (octet_length(token_hash) = 32)
);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  normalized_email extensions.citext not null unique,
  reserved_username extensions.citext not null unique,
  reserved_project_alias extensions.citext not null,
  invited_by uuid references auth.users(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  status public.invite_status not null default 'pending',
  expires_at timestamptz not null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invites_email_normalized check (
    normalized_email::text = lower(normalized_email::text)
  ),
  constraint invites_username_format check (
    reserved_username::text = lower(reserved_username::text)
    and reserved_username::text ~ '^[a-z][a-z0-9_-]{2,31}$'
  ),
  constraint invites_project_alias_format check (
    reserved_project_alias::text = lower(reserved_project_alias::text)
    and reserved_project_alias::text ~ '^[a-z][a-z0-9_-]{1,62}$'
  )
);

create or replace function synapse_private.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

create or replace function synapse_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function synapse_private.set_updated_at();
create trigger projects_set_updated_at
before update on public.projects
for each row execute function synapse_private.set_updated_at();
create trigger memory_nodes_set_updated_at
before update on public.memory_nodes
for each row execute function synapse_private.set_updated_at();
create trigger invites_set_updated_at
before update on public.invites
for each row execute function synapse_private.set_updated_at();

create or replace function synapse_private.accept_profile_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'invited' and new.status = 'active' then
    update public.invites
    set status = 'accepted', error_message = null
    where user_id = new.id and status = 'sent';
  end if;
  return new;
end
$$;

create trigger profiles_accept_invite
after update of status on public.profiles
for each row execute function synapse_private.accept_profile_invite();

create or replace function synapse_private.create_project_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.memory_nodes (
    owner_id, project_id, kind, title, summary, markdown
  ) values (
    new.owner_id, new.id, 'root', 'Memory', 'Synapse memory root', ''
  );
  return new;
end
$$;

create trigger projects_create_root
after insert on public.projects
for each row execute function synapse_private.create_project_root();

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.projects enable row level security;
alter table public.projects force row level security;
alter table public.agent_sessions enable row level security;
alter table public.agent_sessions force row level security;
alter table public.memory_nodes enable row level security;
alter table public.memory_nodes force row level security;
alter table public.memory_revisions enable row level security;
alter table public.memory_revisions force row level security;
alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;
alter table public.development_tokens enable row level security;
alter table public.development_tokens force row level security;

create policy profiles_owner_select on public.profiles
  for select to synapse_runtime
  using (id = synapse_private.current_user_id());
create policy profiles_owner_activate on public.profiles
  for update to synapse_runtime
  using (id = synapse_private.current_user_id() and status <> 'disabled')
  with check (id = synapse_private.current_user_id() and status = 'active');

create policy projects_owner_all on public.projects
  for all to synapse_runtime
  using (owner_id = synapse_private.current_user_id())
  with check (owner_id = synapse_private.current_user_id());
create policy agent_sessions_owner_all on public.agent_sessions
  for all to synapse_runtime
  using (owner_id = synapse_private.current_user_id())
  with check (owner_id = synapse_private.current_user_id());
create policy memory_nodes_owner_all on public.memory_nodes
  for all to synapse_runtime
  using (owner_id = synapse_private.current_user_id())
  with check (owner_id = synapse_private.current_user_id());
create policy memory_revisions_owner_select on public.memory_revisions
  for select to synapse_runtime
  using (owner_id = synapse_private.current_user_id());
create policy memory_revisions_owner_insert on public.memory_revisions
  for insert to synapse_runtime
  with check (owner_id = synapse_private.current_user_id());
create policy audit_events_owner_select on public.audit_events
  for select to synapse_runtime
  using (owner_id = synapse_private.current_user_id());
create policy audit_events_owner_insert on public.audit_events
  for insert to synapse_runtime
  with check (owner_id = synapse_private.current_user_id());
create policy development_tokens_owner_select on public.development_tokens
  for select to synapse_runtime
  using (owner_id = synapse_private.current_user_id());

revoke all on all tables in schema public from anon, authenticated, public;
grant select on public.profiles, public.projects to synapse_runtime;
grant update (status) on public.profiles to synapse_runtime;
grant select, insert, update on public.agent_sessions, public.memory_nodes
  to synapse_runtime;
grant select, insert on public.memory_revisions, public.audit_events
  to synapse_runtime;
grant usage, select on all sequences in schema public to synapse_runtime;
grant execute on function synapse_private.current_user_id() to synapse_runtime;

create or replace function synapse_private.authenticate_development_token(
  candidate_hash bytea
)
returns table(owner_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.development_tokens as token
  set last_used_at = now()
  from public.profiles as profile
  where token.token_hash = candidate_hash
    and token.owner_id = profile.id
    and token.revoked_at is null
    and token.expires_at > now()
    and profile.status = 'active'
  returning token.owner_id, token.expires_at;
end
$$;
revoke all on function synapse_private.authenticate_development_token(bytea)
  from public;
grant execute on function synapse_private.authenticate_development_token(bytea)
  to synapse_runtime;

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb := event->'claims';
  resource_url text;
begin
  if claims ? 'client_id' then
    select value into resource_url
    from public.app_config
    where key = 'mcp_resource_url';
    if resource_url is not null then
      claims := jsonb_set(claims, '{aud}', to_jsonb(resource_url));
    end if;
  end if;
  return jsonb_build_object('claims', claims);
end
$$;
revoke all on function public.custom_access_token_hook(jsonb)
  from public, anon, authenticated;
grant execute on function public.custom_access_token_hook(jsonb)
  to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
grant select on public.app_config to supabase_auth_admin;
