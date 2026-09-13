import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

function launch(path, arguments_ = [], env = process.env) {
  return spawnSync(process.execPath, [resolve(path), ...arguments_], {
    encoding: "utf8",
    env,
  });
}

test("Node entry points execute through native filesystem paths", () => {
  const cli = launch("src/client/cli.mjs", ["--help"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Usage:/);

  const control = launch("plugins/synapse/server/control.mjs");
  assert.equal(control.status, 1);
  assert.match(control.stderr, /Usage: control\.mjs/);

  const env = { ...process.env };
  delete env.DATABASE_ADMIN_URL;
  const migrate = launch("scripts/migrate.mjs", [], env);
  assert.equal(migrate.status, 1);
  assert.match(migrate.stderr, /DATABASE_ADMIN_URL is required/);
});
