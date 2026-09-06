import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repositoryRoot, "plugins", "synapse", ".mcp.json");
const input = process.argv[2];

if (!input) {
  throw new Error("Usage: npm run configure:plugin -- https://<host>/mcp");
}
const url = new URL(input);
if (
  url.protocol !== "https:" ||
  url.pathname !== "/mcp" ||
  url.search ||
  url.hash
) {
  throw new Error("MCP URL must be an HTTPS URL ending exactly in /mcp");
}
const config = {
  mcpServers: {
    "synapse-memory": {
      type: "http",
      url: url.href,
      oauth_resource: url.href,
      startup_timeout_sec: 10,
      tool_timeout_sec: 30,
    },
  },
};
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
process.stdout.write(`Configured Synapse plugin for ${url.href}\n`);
