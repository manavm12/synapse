create or replace function synapse_private.register_identity(
  requested_username text,
  requested_project_alias text
)
returns table (
  account_id uuid,
  account_username text,
  account_status text,
  project_id uuid,
  project_alias text
)
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  verified_user_id uuid := synapse_private.current_user_id();
  verified_email text;
  normalized_username text := lower(btrim(requested_username));
  normalized_project_alias text := lower(btrim(requested_project_alias));
  existing_status public.profile_status;
begin
  if verified_user_id is null then
    raise exception 'authenticated identity is required' using errcode = '42501';
  end if;

  if normalized_username !~ '^[a-z][a-z0-9_-]{2,31}$' then
    raise exception 'invalid username' using errcode = '23514';
  end if;
  if normalized_project_alias !~ '^[a-z][a-z0-9_-]{1,62}$' then
    raise exception 'invalid project alias' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(verified_user_id::text, 0));

  select lower(auth_user.email)
  into verified_email
  from auth.users as auth_user
  where auth_user.id = verified_user_id
    and auth_user.email is not null;

  if verified_email is null then
    raise exception 'verified Supabase user is missing' using errcode = '42501';
  end if;

  select profile.status
  into existing_status
  from public.profiles as profile
  where profile.id = verified_user_id;

  if existing_status = 'disabled' then
    raise exception 'identity is disabled' using errcode = '42501';
  end if;

  if existing_status is null then
    insert into public.profiles (id, username, email, status)
    values (verified_user_id, normalized_username, verified_email, 'active');
  elsif existing_status = 'invited' then
    update public.profiles
    set status = 'active'
    where id = verified_user_id;
  end if;

  insert into public.projects (owner_id, alias, display_name)
  values (
    verified_user_id,
    normalized_project_alias,
    normalized_project_alias
  )
  on conflict (owner_id) do nothing;

  return query
  select
    profile.id,
    profile.username::text,
    profile.status::text,
    project.id,
    project.alias::text
  from public.profiles as profile
  join public.projects as project on project.owner_id = profile.id
  where profile.id = verified_user_id;
end
$$;

revoke all on function synapse_private.register_identity(text, text)
  from public, anon, authenticated;
grant execute on function synapse_private.register_identity(text, text)
  to synapse_runtime;
