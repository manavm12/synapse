begin;
select plan(8);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'one@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'two@example.com');
insert into public.profiles (id, username, email, status) values
  ('00000000-0000-4000-8000-000000000001', 'user_one', 'one@example.com', 'active'),
  ('00000000-0000-4000-8000-000000000002', 'user_two', 'two@example.com', 'active');
insert into public.projects (owner_id, alias, display_name) values
  ('00000000-0000-4000-8000-000000000001', 'project_one', 'Project One'),
  ('00000000-0000-4000-8000-000000000002', 'project_two', 'Project Two');

set local role synapse_runtime;
select set_config('app.current_user_id', '00000000-0000-4000-8000-000000000001', true);

select is((select count(*)::integer from public.profiles), 1, 'profile RLS isolates users');
select is((select count(*)::integer from public.projects), 1, 'project RLS isolates users');
select is((select count(*)::integer from public.memory_nodes), 1, 'memory RLS isolates roots');
select is((select alias::text from public.projects), 'project_one', 'owner sees own project');
select throws_ok(
  $$insert into public.agent_sessions (
      owner_id, project_id, client_session_id, runtime, auth_method
    ) select
      '00000000-0000-4000-8000-000000000002', id, 'cross-user', 'codex', 'oauth'
    from public.projects where alias = 'project_one'$$,
  '23503',
  null,
  'cross-owner session insert fails'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.memory_nodes'::regclass),
  'memory_nodes has RLS'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.memory_nodes'::regclass),
  'memory_nodes forces RLS'
);
select is(
  (select count(*)::integer from public.audit_events),
  0,
  'audit starts empty'
);

select * from finish();
rollback;
