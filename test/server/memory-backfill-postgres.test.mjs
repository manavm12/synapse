import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  backfillMemory,
  parseBackfillArguments,
  runBackfillCli,
} from "../../scripts/backfill-memory.mjs";
import { runMigrations } from "../../scripts/migrate.mjs";

const adminUrl = process.env.TEST_DATABASE_URL;
const ssl = process.env.DATABASE_SSL === "disable" ? false : undefined;
const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const args = ["--owner-id", ownerId, "--project-id", projectId];

test("backfill CLI requires exact scope, bounded limits and explicit apply", async () => {
  assert.deepEqual(parseBackfillArguments(args), {
    ownerId,
    projectId,
    limit: 100,
    apply: false,
  });
  assert.equal(parseBackfillArguments([...args, "--apply"]).apply, true);
  assert.equal(parseBackfillArguments([...args, "--dry-run"]).apply, false);
  assert.equal(
    parseBackfillArguments([...args, "--limit", "1000"]).limit,
    1000,
  );
  for (const invalid of [
    [],
    ["--owner-id", ownerId],
    [...args, "--limit"],
    ["--owner-id", "not-an-owner", "--project-id", projectId],
    [...args, "--apply", "--dry-run"],
    [...args, "--apply", "--apply"],
    [...args, "--processor-version", "2"],
    [...args, "--owner-id", ownerId],
    ...["0", "-1", "1001", "1.5", "1e2", "NaN"].map((limit) => [
      ...args,
      "--limit",
      limit,
    ]),
  ])
    assert.throws(() => parseBackfillArguments(invalid));
  await assert.rejects(
    backfillMemory({ ownerId, projectId, apply: "true" }),
    /explicitly true or false/,
  );
  await assert.rejects(
    backfillMemory({ ownerId, projectId }),
    /DATABASE_ADMIN_URL/,
  );
  let out = "",
    errors = "";
  const io = {
    env: {},
    stdout: {
      write(value) {
        out += value;
      },
    },
    stderr: {
      write(value) {
        errors += value;
      },
    },
  };
  assert.equal(await runBackfillCli(["--help"], io), 0);
  assert.match(out, /read-only preview/);
  assert.equal(await runBackfillCli(args, io), 1);
  assert.match(errors, /DATABASE_ADMIN_URL/);
  errors = "";
  assert.equal(
    await runBackfillCli(args, {
      ...io,
      env: { DATABASE_ADMIN_URL: "private-secret-not-a-database-url" },
    }),
    1,
  );
  assert.doesNotMatch(errors, /private-secret/);
});

test("Postgres backfill previews and enqueues only missing scoped revisions without resetting jobs", {
  skip: !adminUrl,
  timeout: 60_000,
}, async (t) => {
  const admin = new pg.Pool({ connectionString: adminUrl, ssl });
  const name = `synapse_backfill_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  let created = false;
  let database;
  t.after(async () => {
    try {
      await database?.end();
      if (created) await admin.query(`drop database "${name}" with (force)`);
    } finally {
      await admin.end();
    }
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

  async function seed(index, status, count) {
    const identity = { ownerId: randomUUID(), projectId: randomUUID() };
    await database.query("insert into auth.users(id,email) values($1,$2)", [
      identity.ownerId,
      `backfill${index}@example.test`,
    ]);
    await database.query(
      "insert into public.profiles(id,username,email,status) values($1,$2,$3,$4)",
      [
        identity.ownerId,
        `backfill${index}`,
        `backfill${index}@example.test`,
        status,
      ],
    );
    await database.query(
      "insert into public.projects(id,owner_id,alias,display_name) values($1,$2,$3,'Backfill fixture')",
      [identity.projectId, identity.ownerId, `backfill-${index}`],
    );
    const root = (
      await database.query(
        "select id from public.memory_nodes where owner_id=$1 and kind='root'",
        [identity.ownerId],
      )
    ).rows[0];
    const session = randomUUID(),
      node = randomUUID();
    await database.query(
      "insert into public.agent_sessions(id,owner_id,project_id,client_session_id,auth_method) values($1,$2,$3,$4,'fixture')",
      [
        session,
        identity.ownerId,
        identity.projectId,
        `backfill-session-${index}`,
      ],
    );
    await database.query(
      "insert into public.memory_nodes(id,owner_id,project_id,parent_node_id,kind,source_session_id,title) values($1,$2,$3,$4,'session',$5,'Backfill fixture')",
      [
        node,
        identity.ownerId,
        identity.projectId,
        root.id,
        `backfill-session-${index}`,
      ],
    );
    const revisions = [];
    for (let revision = 1; revision <= count; revision++) {
      const id = randomUUID();
      revisions.push(id);
      await database.query(
        `insert into public.memory_revisions(id,owner_id,project_id,node_id,author_session_id,capture_id,capture_reason,revision,title,summary,markdown,content_hash,created_at)
        values($1,$2,$3,$4,$5,$6,'manual',$7,'Private title','Private summary','Private source body',$8,$9)`,
        [
          id,
          identity.ownerId,
          identity.projectId,
          node,
          session,
          randomUUID(),
          revision,
          "a".repeat(64),
          `2026-01-${String(revision).padStart(2, "0")}T00:00:00Z`,
        ],
      );
    }
    return { ...identity, revisions };
  }
  const alice = await seed(1, "active", 5);
  const bob = await seed(2, "active", 1);
  const disabled = await seed(3, "disabled", 1);
  await database.query(
    `insert into synapse_private.memory_processing_jobs(owner_id,project_id,revision_id,processor_version,status,attempt_count,last_error)
    values($1,$2,$3,1,'failed',5,'Private prior failure')`,
    [alice.ownerId, alice.projectId, alice.revisions[1]],
  );
  await database.query(
    `insert into synapse_private.memory_processing_jobs(owner_id,project_id,revision_id,processor_version,status,attempt_count,completed_at)
    values($1,$2,$3,1,'succeeded',1,'2026-02-01T00:00:00Z')`,
    [alice.ownerId, alice.projectId, alice.revisions[3]],
  );
  await database.query(
    `insert into synapse_private.memory_processing_jobs(owner_id,project_id,revision_id,processor_version)
    values($1,$2,$3,2)`,
    [alice.ownerId, alice.projectId, alice.revisions[4]],
  );
  const before = await database.query(
    "select * from synapse_private.memory_processing_jobs order by revision_id,processor_version",
  );
  const sourceBefore = await database.query(
    "select * from public.memory_revisions order by id",
  );
  const options = {
    connectionString: url.href,
    ssl,
    ownerId: alice.ownerId,
    projectId: alice.projectId,
  };
  const preview = await backfillMemory({ ...options, limit: 2 });
  assert.deepEqual(preview, {
    mode: "dry_run",
    owner_id: alice.ownerId,
    project_id: alice.projectId,
    processor_version: 1,
    limit: 2,
    selected_count: 2,
    enqueued_count: 0,
    has_more: true,
    revision_ids: [alice.revisions[0], alice.revisions[2]],
  });
  assert.deepEqual(await backfillMemory({ ...options, limit: 2 }), preview);
  assert.deepEqual(
    (
      await database.query(
        "select * from synapse_private.memory_processing_jobs order by revision_id,processor_version",
      )
    ).rows,
    before.rows,
  );
  const first = await backfillMemory({ ...options, apply: true, limit: 1 });
  assert.equal(first.enqueued_count, 1);
  assert.deepEqual(first.revision_ids, [alice.revisions[0]]);
  const available = await database.query(
    "select job.available_at=revision.created_at as preserved from synapse_private.memory_processing_jobs job join public.memory_revisions revision on revision.id=job.revision_id where job.revision_id=$1",
    [alice.revisions[0]],
  );
  assert.equal(available.rows[0].preserved, true);
  const concurrent = await Promise.all([
    backfillMemory({ ...options, apply: true, limit: 2 }),
    backfillMemory({ ...options, apply: true, limit: 2 }),
  ]);
  assert.equal(
    concurrent.reduce((sum, result) => sum + result.enqueued_count, 0),
    2,
  );
  assert.equal(
    (await backfillMemory({ ...options, apply: true })).enqueued_count,
    0,
  );
  assert.equal((await backfillMemory(options)).selected_count, 0);
  const after = await database.query(
    "select * from synapse_private.memory_processing_jobs order by revision_id,processor_version",
  );
  assert.equal(after.rows.length, 6);
  for (const existing of before.rows)
    assert.deepEqual(
      after.rows.find((row) => row.id === existing.id),
      existing,
    );
  assert.equal(
    after.rows.filter(
      (row) => row.processor_version === 1 && row.status === "pending",
    ).length,
    3,
  );
  assert.ok(
    after.rows.every(
      (row) =>
        row.owner_id === alice.ownerId && row.project_id === alice.projectId,
    ),
  );
  assert.deepEqual(
    (await database.query("select * from public.memory_revisions order by id"))
      .rows,
    sourceBefore.rows,
  );
  for (const apply of [false, true]) {
    await assert.rejects(
      backfillMemory({ ...options, projectId: bob.projectId, apply }),
      /active owner and its exact project/,
    );
    await assert.rejects(
      backfillMemory({
        ...options,
        ownerId: disabled.ownerId,
        projectId: disabled.projectId,
        apply,
      }),
      /active owner and its exact project/,
    );
  }
  assert.deepEqual(
    (
      await backfillMemory({
        ...options,
        ownerId: bob.ownerId,
        projectId: bob.projectId,
      })
    ).revision_ids,
    bob.revisions,
  );
  const runtimeUrl = new URL(url);
  runtimeUrl.searchParams.set("options", "-c role=synapse_runtime");
  await assert.rejects(
    backfillMemory({
      ...options,
      connectionString: runtimeUrl.href,
      apply: true,
    }),
    /configuration, permissions and migrations/,
  );
  let output = "",
    errors = "";
  assert.equal(
    await runBackfillCli(
      ["--owner-id", bob.ownerId, "--project-id", bob.projectId],
      {
        env: { DATABASE_ADMIN_URL: url.href, DATABASE_SSL: "disable" },
        stdout: {
          write(value) {
            output += value;
          },
        },
        stderr: {
          write(value) {
            errors += value;
          },
        },
      },
    ),
    0,
  );
  assert.equal(JSON.parse(output).mode, "dry_run");
  assert.equal(errors, "");
  assert.doesNotMatch(
    output,
    /Private|postgresql|password|source body|\.sqlite/,
  );
  assert.equal(
    (
      await database.query(
        "select count(*)::integer as count from synapse_private.memory_processing_jobs",
      )
    ).rows[0].count,
    6,
  );
});
