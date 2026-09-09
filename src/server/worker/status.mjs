import pg from "pg";

import { databaseConnectionOptions } from "../../database-ssl.mjs";
import { loadWorkerDatabaseConfig } from "./config.mjs";
import {
  requireWorkerRole,
  WorkerDatabaseError,
  workerFailureCategory,
} from "./diagnostics.mjs";
import { parseWorkerArguments, workerScope } from "./options.mjs";

const READ = ["SELECT"],
  APPEND = ["SELECT", "INSERT"],
  MUTATE = [...APPEND, "UPDATE", "DELETE"];
const TABLES = [
  ...["memory_revisions", "memory_nodes", "agent_sessions", "projects"].map(
    (name) => [`public.${name}`, READ],
  ),
  ...["memory_processing_jobs", "memory_processing_project_leases"].map(
    (name) => [`synapse_private.${name}`, [...APPEND, "UPDATE"]],
  ),
  ...[
    "memory_ledger_sources",
    "memory_claims",
    "memory_evidence",
    "memory_claim_evidence",
    "memory_claim_relations",
    "memory_segment_coverage",
  ].map((name) => [`synapse_private.${name}`, APPEND]),
  ...[
    "memory_ledger_projects",
    "memory_projection_topics",
    "memory_projection_notes",
    "memory_projection_note_claims",
    "memory_projection_note_evidence",
    "memory_projection_edges",
  ].map((name) => [`synapse_private.${name}`, MUTATE]),
];

export async function inspectWorkerSchema(client) {
  const { rows } = await client.query(
    `
    with required as (
      select name, permissions, to_regclass(name) as relation
      from jsonb_to_recordset($1::jsonb) as r(name text, permissions text[])
    )
    select name, relation is not null as present,
           coalesce((select bool_and(has_table_privilege(current_user, relation, permission))
             from unnest(permissions) permission), false) as permitted
    from required order by name
  `,
    [
      JSON.stringify(
        TABLES.map(([name, permissions]) => ({ name, permissions })),
      ),
    ],
  );
  return rows;
}

export async function readMemoryStatus({ pool, scope: requestedScope }) {
  const scope = workerScope(requestedScope);
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout = '15s'");
    await client.query("set local lock_timeout = '5s'");
    await requireWorkerRole(client);
    const tables = await inspectWorkerSchema(client);
    if (tables.some((table) => !table.present || !table.permitted)) {
      await client.query("commit");
      return { ready: false, category: "database_schema", tables };
    }
    const ids = [scope.ownerId, scope.projectId];
    await client.query(
      "select set_config('app.current_user_id', $1, true), set_config('app.current_project_id', $2, true)",
      ids,
    );
    const project = await client.query(
      "select id from public.projects where owner_id=$1 and id=$2",
      ids,
    );
    if (project.rowCount !== 1) throw new WorkerDatabaseError("project_scope");
    const {
      rows: [queue],
    } = await client.query(
      `
      select count(*) filter (where status='pending')::integer as pending,
             count(*) filter (where status='processing')::integer as processing,
             count(*) filter (where status='succeeded')::integer as succeeded,
             count(*) filter (where status='failed')::integer as failed,
             min(created_at) filter (where status='pending') as oldest_pending_at,
             max(completed_at) as latest_success_at,
             count(*) filter (where status='processing' and lease_expires_at <= now())::integer as expired_leases
      from synapse_private.memory_processing_jobs
      where owner_id=$1 and project_id=$2 and processor_version=1
    `,
      ids,
    );
    const {
      rows: [history],
    } = await client.query(
      `
      select count(*) filter (where job.id is null)::integer as missing_jobs,
             count(*) filter (where job.status='pending' and exists (
               select 1 from public.memory_revisions older
               join synapse_private.memory_processing_jobs blocked on blocked.revision_id=older.id
               where older.owner_id=$1 and older.project_id=$2
                 and older.node_id=revision.node_id and older.revision<revision.revision
                 and blocked.processor_version=1 and blocked.status='failed'
             ))::integer as blocked_by_failed_revision
      from public.memory_revisions revision
      left join synapse_private.memory_processing_jobs job on job.revision_id=revision.id and job.processor_version=1
      where revision.owner_id=$1 and revision.project_id=$2
    `,
      ids,
    );
    const {
      rows: [ledger],
    } = await client.query(
      `
      select coalesce((select generation from synapse_private.memory_ledger_projects
        where owner_id=$1 and project_id=$2),0)::text as generation,
        (select count(*) from synapse_private.memory_ledger_sources where owner_id=$1 and project_id=$2)::integer as processed_sources
    `,
      ids,
    );
    const workRemaining =
      queue.pending + queue.processing + queue.failed + history.missing_jobs >
      0;
    await client.query("commit");
    return {
      ready: true,
      owner_id: scope.ownerId,
      project_id: scope.projectId,
      processor_version: 1,
      tables,
      queue: { ...queue, ...history },
      ledger,
      work_remaining: workRemaining,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function runStatusCli(
  args,
  {
    env = process.env,
    stdout = process.stdout,
    createPool = (options) => new pg.Pool(options),
  } = {},
) {
  let pool;
  try {
    const options = parseWorkerArguments(args, { status: true });
    if (options.help) {
      stdout.write(
        "Usage: npm run memory:status -- --owner-id <UUID> --project-id <UUID>\nRead-only worker database readiness and processing counts. Requires DATABASE_WORKER_URL and TLS configuration; no inference key is needed.\n",
      );
      return 0;
    }
    const config = loadWorkerDatabaseConfig(env);
    pool = createPool(
      databaseConnectionOptions({
        connectionString: config.databaseUrl,
        ssl: config.databaseSsl,
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
      }),
    );
    const result = await readMemoryStatus({ pool, scope: options.scope });
    stdout.write(
      `${JSON.stringify({ ...result, database_connected: true, tls_verified: config.databaseSsl !== false })}\n`,
    );
    return result.ready ? 0 : 1;
  } catch (error) {
    stdout.write(
      `${JSON.stringify({ ready: false, category: workerFailureCategory(error) })}\n`,
    );
    return 1;
  } finally {
    await pool?.end();
  }
}
