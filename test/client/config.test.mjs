import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPaths,
  relayWebSocketUrl,
  resolveCodexBinary,
  resolveRelayUrl,
} from "../../src/client/config.mjs";

test("configuration keeps relay and host state beneath the Synapse home", () => {
  assert.deepEqual(createPaths({ synapseHome: "/tmp/synapse-home", env: {} }), {
    synapseHome: "/tmp/synapse-home",
    relayDatabase: "/tmp/synapse-home/relay.sqlite",
    hostDatabase: "/tmp/synapse-home/host.sqlite",
    worktreeRoot: "/tmp/synapse-home/worktrees",
    appServerSocket: join(
      homedir(),
      ".codex",
      "app-server-control",
      "app-server-control.sock",
    ),
  });
});

test("relay URL conversion preserves secure transports", () => {
  assert.equal(
    relayWebSocketUrl("http://127.0.0.1:8787"),
    "ws://127.0.0.1:8787/v1/host",
  );
  assert.equal(
    relayWebSocketUrl("https://relay.example.test/base"),
    "wss://relay.example.test/v1/host",
  );
});

test("environment configuration takes precedence", () => {
  assert.equal(resolveRelayUrl({ SYNAPSE_RELAY_URL: "http://localhost:9000" }), "http://localhost:9000");
  assert.equal(
    resolveCodexBinary({ env: { CODEX_BINARY: "/opt/codex" }, pathExists: () => false }),
    "/opt/codex",
  );
});

test("the managed standalone Codex binary is preferred over the desktop bundle", () => {
  assert.match(
    resolveCodexBinary({
      env: {},
      platform: "darwin",
      pathExists: (path) => path.includes("packages/standalone/current/codex"),
    }),
    /packages\/standalone\/current\/codex$/,
  );
});
