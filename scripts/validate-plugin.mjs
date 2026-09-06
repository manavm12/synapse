import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(repositoryRoot, "plugins/synapse");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const manifest = await readJson(resolve(pluginRoot, ".codex-plugin/plugin.json"));
assert(manifest.name === "synapse", "plugin name must match its directory");
assert(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version), "invalid plugin semver");
assert(typeof manifest.description === "string" && manifest.description, "missing description");
assert(manifest.author?.name, "missing author.name");
assert(manifest.interface?.displayName, "missing interface.displayName");
assert(manifest.interface?.shortDescription, "missing interface.shortDescription");
assert(manifest.interface?.longDescription, "missing interface.longDescription");
assert(manifest.interface?.developerName, "missing interface.developerName");
assert(manifest.interface?.category, "missing interface.category");
assert(Array.isArray(manifest.interface?.capabilities), "capabilities must be an array");
assert(manifest.mcpServers === "./.mcp.json", "manifest must expose .mcp.json");
assert(!Object.hasOwn(manifest, "hooks"), "default hooks/hooks.json must be discovered automatically");
assert(!JSON.stringify(manifest).includes("[TODO:"), "manifest contains a TODO placeholder");

const mcp = await readJson(resolve(pluginRoot, ".mcp.json"));
assert(Object.keys(mcp.mcpServers ?? {}).length === 1, "plugin must expose exactly one MCP server");
const memoryServer = mcp.mcpServers?.["synapse-memory"];
assert(memoryServer?.command === "node", "synapse-memory must use the Node launcher");
assert(
  memoryServer?.args?.[0] === "./server/memory-mcp.mjs",
  "synapse-memory must launch the dependency-free server",
);
const memoryServerPath = resolve(pluginRoot, memoryServer.args[0]);
await access(memoryServerPath);
const serverDirectory = resolve(pluginRoot, "server");
for (const file of await readdir(serverDirectory)) {
  if (!file.endsWith(".mjs")) continue;
  const serverSource = await readFile(resolve(serverDirectory, file), "utf8");
  assert(
    !/^\s*import\s+.*?\s+from\s+["'](?!node:|\.)/m.test(serverSource),
    `${file} must not import runtime packages`,
  );
}

const hooks = (await readJson(resolve(pluginRoot, "hooks/hooks.json"))).hooks;
assert(hooks?.Stop?.[0]?.hooks?.[0]?.type === "mcp_tool", "Stop must use an MCP tool hook");
assert(
  hooks.Stop[0].hooks[0].server === "synapse-memory" &&
    hooks.Stop[0].hooks[0].tool === "memory_checkpoint",
  "Stop must call synapse-memory.memory_checkpoint",
);
assert(hooks?.SessionStart?.[0]?.matcher === "^compact$", "SessionStart must match compact only");
assert(!hooks.PreCompact && !hooks.SessionEnd, "unsupported recovery hooks must remain absent");

const marketplacePath = resolve(repositoryRoot, ".agents/plugins/marketplace.json");
const marketplace = await readJson(marketplacePath);
const entry = marketplace.plugins?.find((plugin) => plugin.name === "synapse");
assert(marketplace.name === "synapse", "repository marketplace must be named synapse");
assert(entry?.source?.source === "local", "marketplace source must be local");
assert(entry?.source?.path === "./plugins/synapse", "marketplace source path is invalid");
assert(entry?.policy?.installation === "AVAILABLE", "plugin must be available");
assert(entry?.policy?.authentication === "ON_INSTALL", "plugin auth policy is invalid");

process.stdout.write(`Plugin validation passed: ${pluginRoot}\n`);
