import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { databaseConnectionOptions } from "../../src/database-ssl.mjs";
import { createWorkerRuntime } from "../../src/server/worker/runtime.mjs";

test("database URL options cannot override verified driver TLS", () => {
  const ssl = { rejectUnauthorized: true, ca: "fixture-ca" };
  const url = "postgresql://fixture:fixture@localhost/test";
  for (const parameter of [
    "sslmode=disable",
    "sslmode=no-verify",
    "ssl=0",
    "ssl=true",
    "sslrootcert=private",
    "sslkey=private",
    "sslcert=private",
    "sslnegotiation=direct",
    "uselibpqcompat=true",
  ]) {
    assert.throws(
      () =>
        databaseConnectionOptions({
          connectionString: `${url}?${parameter}`,
          ssl,
        }),
      /Remove SSL options/,
    );
  }
  for (const connectionString of [
    url,
    `${url}?application_name=synapse-worker`,
  ]) {
    const client = new pg.Client(
      databaseConnectionOptions({ connectionString, ssl }),
    );
    assert.deepEqual(client.connectionParameters.ssl, ssl);
  }
  assert.equal(
    new pg.Client(
      databaseConnectionOptions({ connectionString: url, ssl: false }),
    ).connectionParameters.ssl,
    false,
  );
  for (const connectionString of ["not a URL", "https://fixture.invalid"]) {
    assert.throws(
      () => databaseConnectionOptions({ connectionString, ssl }),
      /PostgreSQL URL/,
    );
  }
});

test("worker refuses URL TLS overrides before a pool or API exists", async () => {
  await assert.rejects(
    createWorkerRuntime(
      {
        enabled: true,
        databaseUrl:
          "postgresql://fixture:fixture@localhost/test?sslmode=disable",
        databaseSsl: { rejectUnauthorized: true, ca: "fixture-ca" },
      },
      {
        createPool() {
          assert.fail("must reject before driver construction");
        },
      },
    ),
    /Remove SSL options/,
  );
});
