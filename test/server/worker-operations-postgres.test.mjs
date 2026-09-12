import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { runMigrations } from "../../scripts/migrate.mjs";
import { createMemoryOrganizerHandler } from "../../src/server/memory-organizer/handler.mjs";
import { createMemoryLedgerAdapter } from "../../src/server/memory-organizer/storage.mjs";
import { createMemoryProcessingRunner } from "../../src/server/memory-processing/runner.mjs";
import { createMemoryProcessingStorage } from "../../src/server/memory-processing/storage.mjs";
import { loadWorkerConfig } from "../../src/server/worker/config.mjs";
import { createWorkerRuntime } from "../../src/server/worker/runtime.mjs";
import {
  readMemoryStatus,
  runStatusCli,
} from "../../src/server/worker/status.mjs";

const adminUrl = process.env.TEST_DATABASE_URL;
const ssl = process.env.DATABASE_SSL === "disable" ? false : undefined;

test("Postgres canary scopes claims/recovery, commits reviewed memory and reports blocked/history state read-only", {
  skip: !adminUrl,
  timeout: 60_000,
}, async (t) => {
  const suffix = randomUUID().replaceAll("-", "");
  const name = `synapse_operations_${suffix}`,
    role = `synapse_ops_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, ssl });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  let database,
    worker,
    created = false,
    roleCreated = false;
  t.after(async () => {
    await worker?.end();
    await database?.end();
    if (created) await admin.query(`drop database "${name}"`);
    if (roleCreated) await admin.query(`drop role "${role}"`);
    await admin.end();
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  database = new pg.Pool({ connectionString: url.href, ssl });
  await database.query(
    await readFile(new URL("../sql/bootstrap.sql", import.meta.url), "utf8"),
  );
  await runMigrations({
    connectionString: url.href,
    ssl,
    output: { write() {} },
  });
  await admin.query(
    `create role "${role}" login password 'worker-test-only' nosuperuser nobypassrls inherit`,
  );
  roleCreated = true;
  await admin.query(`grant synapse_memory_worker to "${role}"`);
  const workerUrl = new URL(url);
  workerUrl.username = role;
  workerUrl.password = "worker-test-only";
  worker = new pg.Pool({ connectionString: workerUrl.href, ssl });

  async function seedOwner(index) {
    const scope = { ownerId: randomUUID(), projectId: randomUUID() };
    await database.query("insert into auth.users(id,email) values($1,$2)", [
      scope.ownerId,
      `ops${index}@example.test`,
    ]);
    await database.query(
      "insert into public.profiles(id,username,email,status) values($1,$2,$3,'active')",
      [scope.ownerId, `ops${index}`, `ops${index}@example.test`],
    );
    await database.query(
      "insert into public.projects(id,owner_id,alias,display_name) values($1,$2,$3,'Private project')",
      [scope.projectId, scope.ownerId, `ops-${index}`],
    );
    return scope;
  }
  async function seedSession(scope, count) {
    const {
      rows: [root],
    } = await database.query(
      "select id from public.memory_nodes where project_id=$1 and kind='root'",
      [scope.projectId],
    );
    const node = randomUUID(),
      session = randomUUID(),
      sessionId = randomUUID();
    await database.query(
      "insert into public.agent_sessions(id,owner_id,project_id,client_session_id,auth_method) values($1,$2,$3,$4,'test')",
      [session, scope.ownerId, scope.projectId, sessionId],
    );
    await database.query(
      "insert into public.memory_nodes(id,owner_id,project_id,parent_node_id,kind,source_session_id,title) values($1,$2,$3,$4,'session',$5,'Private title')",
      [node, scope.ownerId, scope.projectId, root.id, sessionId],
    );
    const revisions = [];
    for (let revision = 1; revision <= count; revision++) {
      const id = randomUUID();
      revisions.push(id);
      await database.query(
        `insert into public.memory_revisions(id,owner_id,project_id,node_id,author_session_id,capture_id,capture_reason,revision,title,summary,markdown,content_hash)
        values($1,$2,$3,$4,$5,$6,'manual',$7,'Private title','Private summary','# Decisions\n\nLogs remain for seven days.',$8)`,
        [
          id,
          scope.ownerId,
          scope.projectId,
          node,
          session,
          randomUUID(),
          revision,
          "a".repeat(64),
        ],
      );
    }
    return revisions;
  }
  async function enqueue(scope, revision, state = "pending") {
    const {
      rows: [job],
    } = await database.query(
      `insert into synapse_private.memory_processing_jobs(owner_id,project_id,revision_id,processor_version,status,available_at,attempt_count,last_error)
      values($1,$2,$3,1,$4,'2020-01-01', $5, $6) returning id`,
      [
        scope.ownerId,
        scope.projectId,
        revision,
        state,
        state === "failed" ? 5 : 0,
        state === "failed" ? "Private prior failure" : null,
      ],
    );
    return job.id;
  }
  const alice = await seedOwner(1),
    bob = await seedOwner(2);
  const aliceSources = await seedSession(alice, 3),
    aliceBlocked = await seedSession(alice, 2);
  const bobSources = await seedSession(bob, 2);
  await enqueue(alice, aliceSources[0]);
  await enqueue(alice, aliceSources[1]);
  await enqueue(alice, aliceBlocked[0], "failed");
  await enqueue(alice, aliceBlocked[1]);
  await enqueue(bob, bobSources[0]);
  await enqueue(bob, bobSources[1]);
  const bobStorage = createMemoryProcessingStorage({
    pool: worker,
    scope: bob,
  });
  await bobStorage.claimNext({
    workerId: "crashed-bob",
    now: new Date(Date.now() - 60_000),
    leaseDurationMs: 3000,
  });
  const snapshot = async (scope) => ({
    jobs: (
      await database.query(
        "select * from synapse_private.memory_processing_jobs where owner_id=$1 and project_id=$2 order by id",
        [scope.ownerId, scope.projectId],
      )
    ).rows,
    leases: (
      await database.query(
        "select * from synapse_private.memory_processing_project_leases where project_id=$1",
        [scope.projectId],
      )
    ).rows,
  });
  const bobBefore = await snapshot(bob),
    aliceBefore = await snapshot(alice);
  const before = await readMemoryStatus({ pool: worker, scope: alice });
  assert.equal(before.ready, true);
  assert.deepEqual(
    [
      before.queue.pending,
      before.queue.failed,
      before.queue.missing_jobs,
      before.queue.blocked_by_failed_revision,
    ],
    [3, 1, 1, 1],
  );
  assert.equal(before.ledger.generation, "0");
  assert.deepEqual(await snapshot(alice), aliceBefore);
  assert.deepEqual(await snapshot(bob), bobBefore);
  assert.equal(
    (await readMemoryStatus({ pool: worker, scope: bob })).queue.expired_leases,
    1,
  );
  await assert.rejects(
    readMemoryStatus({
      pool: worker,
      scope: { ownerId: alice.ownerId, projectId: bob.projectId },
    }),
    { category: "project_scope" },
  );
  await assert.rejects(readMemoryStatus({ pool: database, scope: alice }), {
    category: "database_role",
  });

  const stages = [];
  const api = {
    model: "fixture",
    reviewer: "fixture",
    async structured(stage, prompt) {
      stages.push(stage);
      const data = JSON.parse(prompt.split("\n").at(-1));
      let value;
      if (stage === "extract")
        value = {
          claims: [
            {
              ref: "c1",
              subject: "Logs",
              aspect: "Retention",
              scope: "unqualified",
              title: "Retention",
              assertion: "Logs remain for seven days.",
              kind: "decision",
              status: "active",
              topic: "Operations",
              subtopic: "Logging",
              evidence: [data.segments[0].id],
            },
          ],
          coverage: data.segments.map((segment) => ({
            segmentId: segment.id,
            disposition: "claims",
            reason: "Supports retention",
          })),
        };
      else if (stage === "reconcile")
        value = {
          actions: [
            {
              ref: "c1",
              action: "equivalent",
              targets: [data.current[0].id],
              reason: "Same policy",
            },
          ],
        };
      else value = { issues: [] };
      return { value, usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };
  const config = loadWorkerConfig({
    MEMORY_PROCESSING_ENABLED: "true",
    DATABASE_WORKER_URL: workerUrl.href,
    DATABASE_SSL: "disable",
    OPENAI_API_KEY: "fixture",
    MEMORY_MODEL: "fixture",
  });
  async function canary(scope, maxJobs) {
    const runtime = await createWorkerRuntime(config, {
      createPool: (options) => new pg.Pool(options),
      createAdapter: createMemoryLedgerAdapter,
      createAPI: () => api,
      createHandler: createMemoryOrganizerHandler,
      createStorage: createMemoryProcessingStorage,
      createRunner: createMemoryProcessingRunner,
      logger: { info() {}, error() {} },
      signal: new AbortController().signal,
      scope,
      maxJobs,
    });
    try {
      return await runtime.run();
    } finally {
      await runtime.close();
    }
  }
  assert.deepEqual(await canary(alice, 1), {
    status: "limit_reached",
    attempts: 1,
    succeeded: 1,
  });
  assert.deepEqual(stages, ["extract", "review"]);
  assert.deepEqual(await snapshot(bob), bobBefore);
  const second = await canary(alice, 2);
  assert.deepEqual(second, { status: "blocked", attempts: 1, succeeded: 1 });
  assert.deepEqual(stages, [
    "extract",
    "review",
    "extract",
    "reconcile",
    "review",
  ]);
  assert.deepEqual(await snapshot(bob), bobBefore);
  const after = await readMemoryStatus({ pool: worker, scope: alice });
  assert.equal(after.ledger.generation, "2");
  assert.equal(after.ledger.processed_sources, 2);
  assert.equal(after.queue.succeeded, 2);
  assert.equal(after.queue.pending, 1);
  assert.equal(after.work_remaining, true);
  assert.ok(after.queue.latest_success_at);
  const adapter = createMemoryLedgerAdapter({ pool: worker });
  const memory = await adapter.load(alice);
  assert.equal(memory.ledger.claims.length, 2);
  assert.equal(memory.ledger.relations[0].type, "equivalent");
  assert.equal(memory.projection.ledgerVersion, 2);
  assert.equal(memory.projection.items.length, 1);
  assert.equal(memory.projection.items[0].versions[0].evidence.length, 2);

  let output = "";
  const statusArgs = [
    "--owner-id",
    alice.ownerId,
    "--project-id",
    alice.projectId,
  ];
  assert.equal(
    await runStatusCli(statusArgs, {
      env: { DATABASE_WORKER_URL: workerUrl.href, DATABASE_SSL: "disable" },
      stdout: {
        write(value) {
          output += value;
        },
      },
    }),
    0,
  );
  assert.equal(JSON.parse(output).database_connected, true);
  assert.doesNotMatch(output, /Private|seven days|worker-test-only/);

  // A targeted retry never advances to another session or recovers its leases.
  const charlie = await seedOwner(3);
  const [target, successor] = await seedSession(charlie, 2);
  const [unrelated] = await seedSession(charlie, 1);
  await enqueue(charlie, target);
  await enqueue(charlie, successor);
  await enqueue(charlie, unrelated);
  const targeted = (revisionId) =>
    createMemoryProcessingStorage({
      pool: worker,
      scope: { ...charlie, revisionId },
    });
  const targetStore = targeted(target);
  const crashed = await targetStore.claimNext({
    workerId: "crashed-target",
    now: new Date(Date.now() - 60_000),
    leaseDurationMs: 3000,
  });
  assert.equal(crashed.revisionId, target);
  const crashedSnapshot = await snapshot(charlie);
  assert.equal(await targeted(unrelated).recoverExpired(new Date()), 0);
  assert.equal(await targeted(bobSources[0]).recoverExpired(new Date()), 0);
  assert.equal(
    await targeted(bobSources[0]).claimNext({ workerId: "foreign-target" }),
    null,
  );
  assert.equal(
    await targeted(successor).claimNext({ workerId: "blocked-successor" }),
    null,
  );
  assert.deepEqual(await snapshot(charlie), crashedSnapshot);
  assert.equal(await targetStore.recoverExpired(new Date()), 1);
  // Wait-free fixture backoff adjustment; attempt count and error remain intact.
  await database.query(
    "update synapse_private.memory_processing_jobs set available_at='2020-01-01' where revision_id=$1",
    [target],
  );
  assert.deepEqual(await canary({ ...charlie, revisionId: target }, 1), {
    status: "limit_reached",
    attempts: 1,
    succeeded: 1,
  });
  const targetedResult = await snapshot(charlie);
  assert.equal(
    targetedResult.jobs.find((j) => j.revision_id === target).attempt_count,
    2,
  );
  assert.equal(
    targetedResult.jobs.find((j) => j.revision_id === unrelated).attempt_count,
    0,
  );
  assert.equal(
    targetedResult.jobs.find((j) => j.revision_id === successor).attempt_count,
    0,
  );
  assert.equal(
    await targetStore.claimNext({ workerId: "must-not-advance" }),
    null,
  );
  assert.deepEqual(await snapshot(bob), bobBefore);

  await database.query(
    `revoke insert on synapse_private.memory_claims from synapse_memory_worker`,
  );
  try {
    const invalid = await readMemoryStatus({ pool: worker, scope: alice });
    assert.equal(invalid.ready, false);
    assert.equal(
      invalid.tables.find((row) => row.name.endsWith(".memory_claims"))
        .permitted,
      false,
    );
    await assert.rejects(canary(alice, 1), { category: "database_schema" });
  } finally {
    await database.query(
      "grant insert on synapse_private.memory_claims to synapse_memory_worker",
    );
  }
  // Recovery is still available explicitly for the chosen project after canaries.
  assert.equal(await bobStorage.recoverExpired(new Date()), 1);
  assert.notDeepEqual(await snapshot(bob), bobBefore);
});
