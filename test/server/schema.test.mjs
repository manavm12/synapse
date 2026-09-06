import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
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
});
