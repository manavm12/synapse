import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  databaseConnectionOptions,
  databaseSsl,
} from "../src/database-ssl.mjs";

// Matches the capture enqueue and worker defaults; no version override is allowed.
const PROCESSOR_VERSION = 1;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HELP =
  "Usage: node scripts/backfill-memory.mjs --owner-id <UUID> --project-id <UUID> [--limit <1..1000>] [--apply | --dry-run]\nRequires DATABASE_ADMIN_URL. Defaults to a read-only preview of at most 100 missing processor-v1 jobs. --apply only enqueues; it never starts a worker or resets existing jobs.\n";

export class MemoryBackfillError extends Error {
  constructor(message) {
    super(message);
    this.name = "MemoryBackfillError";
  }
}

function validatedOptions({ ownerId, projectId, limit = 100, apply = false }) {
  if (
    typeof ownerId !== "string" ||
    !UUID.test(ownerId) ||
    typeof projectId !== "string" ||
    !UUID.test(projectId)
  )
    throw new MemoryBackfillError("Exact owner and project UUIDs are required");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new MemoryBackfillError("limit must be an integer from 1 to 1000");
  if (typeof apply !== "boolean")
    throw new MemoryBackfillError("apply must be explicitly true or false");
  return {
    ownerId: ownerId.toLowerCase(),
    projectId: projectId.toLowerCase(),
    limit,
    apply,
  };
}

export function parseBackfillArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const parsed = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag))
      throw new MemoryBackfillError("Duplicate backfill option");
    seen.add(flag);
    if (flag === "--apply" || flag === "--dry-run") {
      if (parsed.apply !== undefined)
        throw new MemoryBackfillError("Choose either --apply or --dry-run");
      parsed.apply = flag === "--apply";
      continue;
    }
    if (!["--owner-id", "--project-id", "--limit"].includes(flag))
      throw new MemoryBackfillError("Unknown backfill option; use --help");
    const value = args[++index];
    if (typeof value !== "string" || value.startsWith("--"))
      throw new MemoryBackfillError(
        "A required backfill option value is missing",
      );
    if (flag === "--limit") {
      if (!/^[1-9]\d*$/.test(value))
        throw new MemoryBackfillError(
          "limit must be an integer from 1 to 1000",
        );
      parsed.limit = Number(value);
    } else parsed[flag === "--owner-id" ? "ownerId" : "projectId"] = value;
  }
  return validatedOptions(parsed);
}

export async function backfillMemory({ connectionString, ssl, ...options }) {
  const requested = validatedOptions(options);
  if (typeof connectionString !== "string" || !connectionString.trim())
    throw new MemoryBackfillError("DATABASE_ADMIN_URL is required");
  const pool = new pg.Pool(
    databaseConnectionOptions({
      connectionString,
      ssl: ssl ?? databaseSsl(),
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
    }),
  );
  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query(
      requested.apply
        ? "begin"
        : "begin isolation level repeatable read read only",
    );
    inTransaction = true;
    await client.query("set local statement_timeout = '15s'");
    await client.query("set local lock_timeout = '5s'");
    const identity = await client.query(
      `select project.owner_id, project.id as project_id, profile.status::text
       from public.projects as project
       join public.profiles as profile on profile.id = project.owner_id
       where project.owner_id = $1 and project.id = $2 and profile.status = 'active'
       ${requested.apply ? "for share of project, profile" : ""}`,
      [requested.ownerId, requested.projectId],
    );
    const scope = identity.rows[0];
    if (
      identity.rowCount !== 1 ||
      scope.owner_id !== requested.ownerId ||
      scope.project_id !== requested.projectId ||
      scope.status !== "active"
    )
      throw new MemoryBackfillError(
        "An active owner and its exact project are required",
      );
    const candidates = await client.query(
      `select revision.id, revision.owner_id, revision.project_id
       from public.memory_revisions as revision
       where revision.owner_id = $1 and revision.project_id = $2
         and not exists (
           select 1 from synapse_private.memory_processing_jobs as job
           where job.revision_id = revision.id and job.processor_version = $3
         )
       order by revision.created_at, revision.node_id, revision.revision, revision.id
       limit $4`,
      [
        scope.owner_id,
        scope.project_id,
        PROCESSOR_VERSION,
        requested.limit + 1,
      ],
    );
    for (const row of candidates.rows)
      if (
        !UUID.test(row.id) ||
        row.owner_id !== scope.owner_id ||
        row.project_id !== scope.project_id
      )
        throw new MemoryBackfillError(
          "Backfill source identity validation failed",
        );
    const selected = candidates.rows.slice(0, requested.limit);
    let enqueued = 0;
    if (requested.apply && selected.length) {
      const inserted = await client.query(
        `insert into synapse_private.memory_processing_jobs
           (owner_id, project_id, revision_id, processor_version, available_at)
         select revision.owner_id, revision.project_id, revision.id, $3, revision.created_at
         from public.memory_revisions as revision
         where revision.owner_id = $1 and revision.project_id = $2 and revision.id = any($4::uuid[])
         order by revision.created_at, revision.node_id, revision.revision, revision.id
         on conflict (revision_id, processor_version) do nothing`,
        [
          scope.owner_id,
          scope.project_id,
          PROCESSOR_VERSION,
          selected.map((row) => row.id),
        ],
      );
      enqueued = inserted.rowCount;
    }
    await client.query("commit");
    inTransaction = false;
    return {
      mode: requested.apply ? "apply" : "dry_run",
      owner_id: scope.owner_id,
      project_id: scope.project_id,
      processor_version: PROCESSOR_VERSION,
      limit: requested.limit,
      selected_count: selected.length,
      enqueued_count: enqueued,
      has_more: candidates.rows.length > requested.limit,
      revision_ids: selected.map((row) => row.id),
    };
  } catch (error) {
    if (inTransaction) await client.query("rollback").catch(() => {});
    if (error instanceof MemoryBackfillError) throw error;
    throw new MemoryBackfillError(
      "Memory backfill failed; check database configuration, permissions and migrations",
    );
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function runBackfillCli(
  args,
  { env = process.env, stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    const options = parseBackfillArguments(args);
    if (options.help) {
      stdout.write(HELP);
      return 0;
    }
    const summary = await backfillMemory({
      ...options,
      connectionString: env.DATABASE_ADMIN_URL,
      ssl: databaseSsl(env),
    });
    stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    stderr.write(
      `${error instanceof MemoryBackfillError ? error.message : "Memory backfill failed; check configuration"}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runBackfillCli(process.argv.slice(2));
