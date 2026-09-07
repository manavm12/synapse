import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { runMigrations } from "../../scripts/migrate.mjs";
import {
  createDatabase,
  MemoryConflictError,
  UsernameTakenError,
} from "../../src/server/database.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const adminUrl = process.env.TEST_DATABASE_URL;
const databaseSsl = process.env.DATABASE_SSL === "disable" ? false : undefined;

function runtimeUrl(connectionString) {
  const url = new URL(connectionString);
  url.username = "synapse_runtime";
  url.password = "synapse-runtime-test-password";
  return url.href;
}

function roleUrl(connectionString, username, password) {
  const url = new URL(connectionString);
  url.username = username;
  url.password = password;
  return url.href;
}

test("migration enforces user isolation and durable capture semantics", {
  skip: !adminUrl,
}, async (t) => {
  const admin = new pg.Pool({ connectionString: adminUrl, ssl: databaseSsl });
  t.after(() => admin.end());
  const bootstrap = await readFile(
    resolve(repositoryRoot, "test/sql/bootstrap.sql"),
    "utf8",
  );
  await admin.query(bootstrap);
  await runMigrations({
    connectionString: adminUrl,
    ssl: databaseSsl,
    output: { write() {} },
  });
  await admin.query(
    "alter role synapse_runtime with login password 'synapse-runtime-test-password'",
  );

  const userOne = "00000000-0000-4000-8000-000000000001";
  const userTwo = "00000000-0000-4000-8000-000000000002";
  const userThree = "00000000-0000-4000-8000-000000000003";
  const userFour = "00000000-0000-4000-8000-000000000004";
  await admin.query(
    `insert into auth.users (id, email) values
         ($1, 'one@example.com'), ($2, 'two@example.com'),
         ($3, 'three@example.com'), ($4, 'four@example.com')
       on conflict (id) do nothing`,
    [userOne, userTwo, userThree, userFour],
  );
  await admin.query(
    `insert into public.profiles (id, username, email, status) values
         ($1, 'user_one', 'one@example.com', 'active'),
         ($2, 'user_two', 'two@example.com', 'active')
       on conflict (id) do nothing`,
    [userOne, userTwo],
  );
  await admin.query(
    `insert into public.projects (owner_id, alias, display_name) values
         ($1, 'shared', 'Project One'),
         ($2, 'shared', 'Project Two')
       on conflict (owner_id) do nothing`,
    [userOne, userTwo],
  );

  const rls = await admin.connect();
  try {
    await rls.query("begin");
    await rls.query("set local role synapse_runtime");
    await rls.query("select set_config('app.current_user_id', $1, true)", [
      userOne,
    ]);
    assert.equal(
      Number(
        (await rls.query("select count(*) from public.profiles")).rows[0].count,
      ),
      1,
    );
    assert.deepEqual(
      (await rls.query("select alias::text from public.projects")).rows.map(
        (row) => row.alias,
      ),
      ["shared"],
    );
    assert.equal(
      Number(
        (await rls.query("select count(*) from public.memory_nodes")).rows[0]
          .count,
      ),
      1,
    );
    await rls.query("rollback");
  } finally {
    rls.release();
  }

  const database = createDatabase({
    databaseUrl: runtimeUrl(adminUrl),
    databaseSsl,
  });
  t.after(() => database.close());

  assert.equal(await database.getAccount(userThree), null);
  const registered = await database.registerAccount(userThree, {
    username: "agent_three",
    projectAlias: "synapse",
  });
  assert.equal(registered.username, "agent_three");
  assert.equal(registered.projectAlias, "synapse");
  assert.deepEqual(
    await database.registerAccount(userThree, {
      username: "ignored_name",
      projectAlias: "ignored-project",
    }),
    registered,
  );
  await assert.rejects(
    database.registerAccount(userFour, {
      username: "agent_three",
      projectAlias: "synapse",
    }),
    UsernameTakenError,
  );
  const provisioned = await admin.query(
    `select profile.status::text,
            (select count(*) from public.memory_nodes
             where owner_id = $1 and kind = 'root') as roots
     from public.profiles as profile
     where profile.id = $1`,
    [userThree],
  );
  assert.deepEqual(provisioned.rows[0], { status: "active", roots: "1" });

  const identity = await database.resolveIdentity(userOne, {
    authMethod: "oauth",
    oauthClientId: "codex-test-client",
  });
  assert.equal(identity.principalType, "user");
  assert.equal(identity.projectAlias, "shared");

  const input = {
    captureId: "00000000-0000-4000-8000-000000000101",
    sessionId: "codex-session-1",
    projectAlias: "shared",
    captureReason: "turn_checkpoint",
    title: "Foundation",
    summary: "Cloud memory was stored.",
    markdown: "# Summary\nCloud memory was stored.",
  };
  const first = await database.saveSessionMemory(
    identity,
    input,
    "00000000-0000-4000-8000-000000000201",
  );
  assert.equal(first.idempotent, false);
  assert.equal(first.revision, 1);
  const replay = await database.saveSessionMemory(
    identity,
    input,
    "00000000-0000-4000-8000-000000000202",
  );
  assert.equal(replay.idempotent, true);
  assert.equal(replay.nodeId, first.nodeId);

  await assert.rejects(
    database.saveSessionMemory(
      identity,
      { ...input, summary: "Different content." },
      "00000000-0000-4000-8000-000000000203",
    ),
    MemoryConflictError,
  );
  const counts = await admin.query(
    `select
         (select count(*) from public.memory_revisions where owner_id = $1) as revisions,
         (select count(*) from public.audit_events
          where owner_id = $1 and action = 'memory.capture_conflict') as conflicts`,
    [userOne],
  );
  assert.equal(Number(counts.rows[0].revisions), 1);
  assert.equal(Number(counts.rows[0].conflicts), 1);
  assert.equal(
    Number(
      (
        await admin.query(
          `select count(*) from synapse_private.memory_processing_jobs
           where owner_id = $1`,
          [userOne],
        )
      ).rows[0].count,
    ),
    1,
  );

  await admin.query(
    "alter role synapse_memory_worker with login password 'memory-worker-test-password'",
  );
  await admin.query(
    `create table synapse_private.test_memory_processing_results (
       revision_id uuid primary key,
       marker text not null
     )`,
  );
  await admin.query(
    `grant select, insert on synapse_private.test_memory_processing_results
     to synapse_memory_worker`,
  );
  const { createMemoryProcessingStorage, MemoryProcessingLeaseLostError } =
    await import("../../src/server/memory-processing/storage.mjs");
  const workerUrl = roleUrl(
    adminUrl,
    "synapse_memory_worker",
    "memory-worker-test-password",
  );
  const storage = createMemoryProcessingStorage({
    databaseUrl: workerUrl,
    databaseSsl,
    retryDelay: () => 0,
  });
  t.after(() => storage.close());
  const processingTime = new Date(Date.now() + 60_000);
  const firstJob = await storage.claimNext({
    workerId: "worker-one",
    leaseDurationMs: 5_000,
    now: processingTime,
  });
  assert.equal(firstJob.source.version, 1);
  assert.equal(firstJob.source.ownerId, userOne);
  assert.equal(firstJob.source.revision, 1);
  assert.equal(firstJob.source.captureId, input.captureId);
  assert.equal(firstJob.source.sessionId, input.sessionId);
  assert.equal(firstJob.source.markdown, input.markdown);

  const secondInput = {
    ...input,
    captureId: "00000000-0000-4000-8000-000000000102",
    summary: "A second accepted revision.",
    markdown: "# Summary\nA second accepted revision.",
  };
  const secondSave = await database.saveSessionMemory(
    identity,
    secondInput,
    "00000000-0000-4000-8000-000000000204",
  );
  assert.equal(secondSave.revision, 2);
  const parallelInput = {
    ...input,
    captureId: "00000000-0000-4000-8000-000000000105",
    sessionId: "codex-session-parallel",
    summary: "A different session in the same project.",
  };
  await database.saveSessionMemory(
    identity,
    parallelInput,
    "00000000-0000-4000-8000-000000000207",
  );
  assert.equal(
    await storage.claimNext({
      workerId: "worker-two",
      leaseDurationMs: 5_000,
      now: processingTime,
    }),
    null,
  );
  await assert.rejects(
    storage.complete(
      firstJob,
      async (client) => {
        await client.query(
          `insert into synapse_private.test_memory_processing_results
           (revision_id, marker) values ($1, 'must-roll-back')`,
          [firstJob.revisionId],
        );
        throw new Error("derived commit rejected");
      },
      { now: processingTime },
    ),
    /derived commit rejected/,
  );
  assert.equal(
    Number(
      (
        await admin.query(
          `select count(*)
           from synapse_private.test_memory_processing_results`,
        )
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    await storage.complete(
      firstJob,
      (client) =>
        client.query(
          `insert into synapse_private.test_memory_processing_results
         (revision_id, marker) values ($1, 'committed')`,
          [firstJob.revisionId],
        ),
      { now: processingTime },
    ),
    true,
  );
  assert.equal(
    await storage.complete(firstJob, async () => {}, { now: processingTime }),
    false,
  );
  const concurrentClaims = await Promise.all([
    storage.claimNext({
      workerId: "worker-two-a",
      leaseDurationMs: 5_000,
      now: processingTime,
    }),
    storage.claimNext({
      workerId: "worker-two-b",
      leaseDurationMs: 5_000,
      now: processingTime,
    }),
  ]);
  const claimedJobs = concurrentClaims.filter(Boolean);
  assert.equal(claimedJobs.length, 1);
  await storage.complete(claimedJobs[0], async () => {}, {
    now: processingTime,
  });
  const remainingProjectJob = await storage.claimNext({
    workerId: "worker-two-c",
    leaseDurationMs: 5_000,
    now: processingTime,
  });
  const processedSources = [
    claimedJobs[0].source,
    remainingProjectJob.source,
  ].map(({ sessionId, revision }) => `${sessionId}:${revision}`);
  assert.deepEqual(processedSources.sort(), [
    `${input.sessionId}:2`,
    `${parallelInput.sessionId}:1`,
  ]);
  await storage.complete(remainingProjectJob, async () => {}, {
    now: processingTime,
  });

  const identityTwo = await database.resolveIdentity(userTwo, {
    authMethod: "oauth",
    oauthClientId: "codex-test-client",
  });
  await database.saveSessionMemory(
    identityTwo,
    {
      ...input,
      captureId: "00000000-0000-4000-8000-000000000103",
      sessionId: "codex-session-crash",
    },
    "00000000-0000-4000-8000-000000000205",
  );
  const crashedJob = await storage.claimNext({
    workerId: "crashed-worker",
    leaseDurationMs: 100,
    now: processingTime,
  });
  const recoveredAt = new Date(processingTime.getTime() + 101);
  const recoveredJob = await storage.claimNext({
    workerId: "replacement-worker",
    leaseDurationMs: 5_000,
    now: recoveredAt,
  });
  assert.equal(recoveredJob.id, crashedJob.id);
  assert.ok(BigInt(recoveredJob.leaseFence) > BigInt(crashedJob.leaseFence));
  let staleCommitCalled = false;
  await assert.rejects(
    storage.complete(
      crashedJob,
      async () => {
        staleCommitCalled = true;
      },
      { now: recoveredAt },
    ),
    MemoryProcessingLeaseLostError,
  );
  assert.equal(staleCommitCalled, false);
  await storage.complete(recoveredJob, async () => {}, { now: recoveredAt });

  const thirdInput = {
    ...secondInput,
    captureId: "00000000-0000-4000-8000-000000000104",
    summary: "A retry test.",
  };
  await database.saveSessionMemory(
    identity,
    thirdInput,
    "00000000-0000-4000-8000-000000000206",
  );
  await admin.query(
    `update synapse_private.memory_processing_jobs
     set max_attempts = 2
     where revision_id = (
       select id from public.memory_revisions where capture_id = $1
     )`,
    [thirdInput.captureId],
  );
  const retryOne = await storage.claimNext({
    workerId: "retry-worker",
    leaseDurationMs: 5_000,
    now: processingTime,
  });
  assert.equal(
    await storage.fail(retryOne, new Error("first failure"), {
      now: processingTime,
    }),
    "pending",
  );
  const retryTwo = await storage.claimNext({
    workerId: "retry-worker",
    leaseDurationMs: 5_000,
    now: processingTime,
  });
  assert.equal(retryTwo.id, retryOne.id);
  assert.equal(
    await storage.fail(retryTwo, new Error("final failure"), {
      now: processingTime,
    }),
    "failed",
  );
  const finalJob = await admin.query(
    `select status::text, attempt_count, last_error
     from synapse_private.memory_processing_jobs where id = $1`,
    [retryTwo.id],
  );
  assert.deepEqual(finalJob.rows[0], {
    status: "failed",
    attempt_count: 2,
    last_error: "final failure",
  });

  // Opt-in Postgres fixture code is exercised by test:sql. Keep skipped test
  // bodies out of unit-test coverage; production storage remains measurable.
  /* node:coverage disable */
  async function capture(owner, sessionId, processorVersion = 1) {
    const captureId = randomUUID();
    await database.saveSessionMemory(
      owner,
      { ...input, captureId, sessionId },
      randomUUID(),
    );
    if (processorVersion !== 1) {
      await admin.query(
        `update synapse_private.memory_processing_jobs set processor_version = $2
         where revision_id = (
           select id from public.memory_revisions where capture_id = $1
         )`,
        [captureId, processorVersion],
      );
    }
  }

  // Gates wrap real worker connections, pausing after their first locking
  // statement. Both database time inputs and the interleaving are controlled.
  function gatedStorage(subtest) {
    const started = Promise.withResolvers();
    const locked = Promise.withResolvers();
    const resume = Promise.withResolvers();
    let first = true;
    const workerPool = new pg.Pool({
      connectionString: workerUrl,
      ssl: databaseSsl,
      options: "-c statement_timeout=5000",
    });
    subtest.after(async () => {
      resume.resolve();
      await workerPool.end();
    });
    const worker = createMemoryProcessingStorage({
      retryDelay: () => 0,
      pool: {
        async connect() {
          const client = await workerPool.connect();
          return {
            release: () => client.release(),
            async query(sql, values) {
              const pause = first && /for update|^\s*update\s/i.test(sql);
              if (pause) {
                first = false;
                started.resolve(client.processID);
              }
              const result = await client.query(sql, values);
              if (pause) {
                locked.resolve(result);
                await resume.promise;
              }
              return result;
            },
          };
        },
      },
    });
    return { worker, started, locked, resume };
  }

  for (const [processorVersion, winner] of [
    [101, "renewal"],
    [102, "recovery"],
  ]) {
    await t.test(
      `${winner} wins the renewal/recovery race without deadlock`,
      {
        timeout: 15_000,
      },
      async (subtest) => {
        const ownerId = randomUUID();
        await admin.query(
          "insert into auth.users (id, email) values ($1, $2)",
          [ownerId, `${ownerId}@example.com`],
        );
        await database.registerAccount(ownerId, {
          username: `race_${winner}`,
          projectAlias: "shared",
        });
        const owner = await database.resolveIdentity(ownerId, {
          authMethod: "oauth",
          oauthClientId: "concurrency-test",
        });
        await capture(owner, `lease-race-${winner}`, processorVersion);
        const job = await storage.claimNext({
          workerId: "renewing-worker",
          processorVersion,
          leaseDurationMs: 100,
          now: processingTime,
        });
        const renewingAt = new Date(processingTime.getTime() + 50);
        const expiredAt = new Date(processingTime.getTime() + 101);
        const renewal = gatedStorage(subtest);
        const recovery = gatedStorage(subtest);
        const renew = () =>
          renewal.worker.renewLease(job, {
            leaseDurationMs: 5_000,
            now: renewingAt,
          });
        let outcomes;
        if (winner === "renewal") {
          const renewing = renew();
          await renewal.locked.promise;
          const recovering = recovery.worker.recoverExpired(expiredAt);
          outcomes = Promise.allSettled([renewing, recovering]);
          await recovery.locked.promise;
          renewal.resume.resolve();
          recovery.resume.resolve();
        } else {
          const recovering = recovery.worker.recoverExpired(expiredAt);
          await recovery.locked.promise;
          const renewing = renew();
          outcomes = Promise.allSettled([renewing, recovering]);
          const renewingPid = await renewal.started.promise;
          renewal.resume.resolve();
          // Release recovery only after Postgres confirms renewal is waiting on
          // its lock. No sleep-based assumption decides which transaction wins.
          let blocked = false;
          const deadline = Date.now() + 3_000;
          while (!blocked && Date.now() < deadline) {
            const result = await admin.query(
              "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
              [renewingPid],
            );
            blocked = result.rows[0].blocked;
            if (!blocked) await setTimeout(10);
          }
          recovery.resume.resolve();
          assert.equal(blocked, true);
        }
        const [renewed, recovered] = await outcomes;
        for (const outcome of [renewed, recovered]) {
          assert.notEqual(
            outcome.reason?.code,
            "40P01",
            outcome.reason?.message,
          );
        }
        assert.equal(recovered.status, "fulfilled", recovered.reason?.message);
        assert.equal(recovered.value, winner === "renewal" ? 0 : 1);
        if (winner === "renewal") {
          assert.equal(renewed.status, "fulfilled", renewed.reason?.message);
          assert.equal(await storage.recoverExpired(expiredAt), 0);
          const live = await admin.query(
            `select status::text, attempt_count, lease_token, lease_expires_at
           from synapse_private.memory_processing_jobs where id = $1`,
            [job.id],
          );
          assert.deepEqual(live.rows[0], {
            status: "processing",
            attempt_count: 1,
            lease_token: job.leaseToken,
            lease_expires_at: new Date(renewingAt.getTime() + 5_000),
          });
          await storage.complete(job, async () => {}, { now: expiredAt });
        } else {
          assert.equal(renewed.status, "rejected");
          assert.ok(renewed.reason instanceof MemoryProcessingLeaseLostError);
          const retry = await storage.claimNext({
            workerId: "recovered-worker",
            processorVersion,
            now: expiredAt,
          });
          assert.equal(retry.id, job.id);
          assert.equal(retry.attemptCount, 2);
          assert.ok(BigInt(retry.leaseFence) > BigInt(job.leaseFence));
          await storage.complete(retry, async () => {}, { now: expiredAt });
        }
      },
    );
  }

  await t.test(
    "51 sessions in an active project do not hide another tenant",
    async () => {
      for (let session = 0; session < 51; session += 1) {
        await capture(identity, `crowded-project-${session}`);
      }
      // Force an unambiguous queue order independently of timestamp precision.
      await admin.query(
        `update synapse_private.memory_processing_jobs set available_at = $2
       where owner_id = $1 and status = 'pending'`,
        [userOne, new Date(processingTime.getTime() - 1_000)],
      );
      const busy = await storage.claimNext({
        workerId: "busy-project-worker",
        now: processingTime,
      });
      assert.equal(busy.ownerId, userOne);
      await capture(identityTwo, "ready-other-tenant");
      await admin.query(
        `update synapse_private.memory_processing_jobs set available_at = $2
       where owner_id = $1 and status = 'pending'`,
        [userTwo, processingTime],
      );
      const other = await storage.claimNext({
        workerId: "other-project-worker",
        now: processingTime,
      });
      assert.ok(
        other,
        "another tenant's ready job must survive the candidate limit",
      );
      assert.equal(other.ownerId, userTwo);
      assert.equal(other.source.sessionId, "ready-other-tenant");
      const pending = await admin.query(
        `select count(*)::integer as count
       from synapse_private.memory_processing_jobs
       where owner_id = $1 and status = 'pending'`,
        [userOne],
      );
      assert.equal(pending.rows[0].count, 50);
      await storage.complete(busy, async () => {}, { now: processingTime });
      await storage.complete(other, async () => {}, { now: processingTime });
    },
  );
  /* node:coverage enable */
});
