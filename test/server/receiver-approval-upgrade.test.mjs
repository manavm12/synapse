import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { runMigrations } from "../../scripts/migrate.mjs";
import { createDatabase } from "../../src/server/database.mjs";

const adminUrl = process.env.TEST_DATABASE_URL;
const ssl = process.env.DATABASE_SSL === "disable" ? false : undefined;
const migration = "202609090002_require_bound_receiver_approval.sql";
const migrationDirectory = new URL(
  "../../supabase/migrations/",
  import.meta.url,
);
const credential = () => `syn_recv_${randomBytes(32).toString("base64url")}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("approval upgrade rejects unbound pending pairings and preserves connected legacy receivers", {
  skip: !adminUrl,
}, async (t) => {
  const admin = new pg.Pool({ connectionString: adminUrl, ssl });
  const name = `synapse_approval_upgrade_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await admin.query(`create database "${name}" template template0`);
  const seed = new pg.Pool({ connectionString: url.href, ssl });
  const oldDirectory = await mkdtemp(join(tmpdir(), "synapse-old-migrations-"));
  let database;
  t.after(async () => {
    await database?.close();
    await seed.end();
    await admin.query(`drop database "${name}"`);
    await admin.end();
    await rm(oldDirectory, { recursive: true, force: true });
  });
  await seed.query(
    await readFile(new URL("../sql/bootstrap.sql", import.meta.url), "utf8"),
  );
  for (const file of await readdir(migrationDirectory)) {
    if (/^\d+.*\.sql$/.test(file) && file < migration) {
      await symlink(
        new URL(file, migrationDirectory),
        join(oldDirectory, file),
      );
    }
  }
  await runMigrations({
    connectionString: url.href,
    ssl,
    directory: oldDirectory,
    output: { write() {} },
  });
  const migrationUrl = url.href;
  url.searchParams.set("options", "-c role=synapse_runtime");
  database = createDatabase({ databaseUrl: url.href, databaseSsl: ssl });
  const owner = randomUUID();
  const stranger = randomUUID();
  for (const [id, username] of [
    [owner, "legacy_owner"],
    [stranger, "other_owner"],
  ]) {
    await seed.query("insert into auth.users(id,email) values($1,$2)", [
      id,
      `${username}@example.test`,
    ]);
    await database.registerAccount(id, {
      username,
      projectAlias: "same_alias",
    });
  }
  const requesterHash = randomBytes(32);
  const pendingCredential = credential();
  const pending = await database.createReceiverPairing(
    hash(pendingCredential),
    requesterHash,
  );
  const legacyCredential = credential();
  const legacy = await database.createReceiverPairing(
    hash(legacyCredential),
    requesterHash,
  );
  const connected = await database.approveReceiverPairing(
    owner,
    legacy.pairingId,
  );
  assert.equal(
    (
      await seed.query(
        "select expected_owner_id from public.receiver_pairings where id=$1",
        [legacy.pairingId],
      )
    ).rows[0].expected_owner_id,
    null,
  );

  assert.deepEqual(
    await runMigrations({
      connectionString: migrationUrl,
      ssl,
      output: { write() {} },
    }),
    [migration],
  );
  assert.deepEqual(
    await runMigrations({
      connectionString: migrationUrl,
      ssl,
      output: { write() {} },
    }),
    [],
  );
  const newUnbound = await database.createReceiverPairing(
    hash(credential()),
    requesterHash,
  );
  for (const pairing of [pending, newUnbound]) {
    for (const user of [owner, stranger]) {
      await assert.rejects(
        database.approveReceiverPairing(user, pairing.pairingId),
        (error) => error.code === "forbidden",
      );
    }
  }
  assert.deepEqual(
    await database.completeReceiverPairing(
      pendingCredential,
      pending.pairingId,
    ),
    { status: "pending" },
  );
  assert.equal(
    (await database.approveReceiverPairing(owner, legacy.pairingId))
      .installationId,
    connected.installationId,
  );
  await assert.rejects(
    database.approveReceiverPairing(stranger, legacy.pairingId),
    (error) => error.code === "forbidden",
  );
  assert.equal(
    (await database.completeReceiverPairing(legacyCredential, legacy.pairingId))
      .identity.installationId,
    connected.installationId,
  );
  assert.equal(
    (await database.getReceiverIdentity(legacyCredential)).installationId,
    connected.installationId,
  );
  assert.deepEqual(
    (await database.claimReceiverMessages(legacyCredential, 1)).messages,
    [],
  );
  assert.equal(
    (
      await seed.query(
        "select has_function_privilege('synapse_runtime', 'synapse_private.approve_receiver_pairing_legacy(uuid)', 'execute') as allowed",
      )
    ).rows[0].allowed,
    false,
  );
  await seed.query(
    "update public.receiver_installations set expires_at=now()-interval '1 second' where id=$1",
    [connected.installationId],
  );
  assert.equal(await database.getReceiverIdentity(legacyCredential), null);
  assert.equal(await database.disconnectReceiver(legacyCredential), true);

  const identity = await database.resolveIdentity(owner, {
    authMethod: "oauth",
    oauthClientId: "upgrade-test",
  });
  const bound = await database.createBoundReceiverPairing(
    identity,
    hash(credential()),
  );
  await assert.rejects(
    database.approveReceiverPairing(stranger, bound.pairingId),
    (error) => error.code === "forbidden",
  );
  assert.equal(
    (await database.approveReceiverPairing(owner, bound.pairingId)).userId,
    owner,
  );
});
