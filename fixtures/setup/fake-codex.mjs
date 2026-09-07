// An isolated subprocess fixture; it never contacts Codex or an OAuth server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = process.env.SETUP_TEST_REPOSITORY;
const key = process.argv.slice(2).join(" ");
const pluginRoot = join(repositoryRoot, "plugins/synapse");
const manifest = JSON.parse(
  readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
);
const server = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"))
  .mcpServers["synapse-memory"];

if (key === "--version") {
  process.stdout.write("codex-cli fixture\n");
} else if (key === "plugin marketplace list --json") {
  process.stdout.write(
    JSON.stringify({
      marketplaces: [{ name: "synapse", root: repositoryRoot }],
    }),
  );
} else if (key === "plugin list --json") {
  process.stdout.write(
    JSON.stringify({
      installed: [
        {
          pluginId: "synapse@synapse",
          version: manifest.version,
          enabled: true,
          source: { path: pluginRoot },
        },
      ],
    }),
  );
} else if (key === "mcp list --json") {
  process.stdout.write(
    JSON.stringify([
      {
        name: "synapse-memory",
        enabled: true,
        transport: { type: "streamable_http", url: server.url },
        auth_status: "o_auth",
      },
    ]),
  );
} else if (key === "mcp login synapse-memory") {
  setTimeout(() => process.exit(3), 5000).unref();
  process.stdout.write("Waiting for browser authorization\n");
  process.stderr.write(
    "https://example.invalid/authorize?state=fixture-state\n",
  );
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  // Check a synthetic credential without echoing or persisting it.
  assert.equal(input.trim() === "synthetic-oauth-credential", true);
  process.stdout.write("Login completed\n");
} else {
  throw new Error("Unexpected fixture command");
}
