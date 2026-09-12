import { access, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(repositoryRoot, "plugins/synapse");
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidSemver(value) {
  return typeof value === "string" && semverPattern.test(value);
}

export function findRuntimePackageLoads(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?!["'])[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith("node:") && !specifier.startsWith(".")) {
        specifiers.add(specifier);
      }
    }
  }
  if (/\bcreateRequire\s*\(/.test(source)) {
    specifiers.add("createRequire()");
  }
  return [...specifiers];
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const manifest = await readJson(
  resolve(pluginRoot, ".codex-plugin/plugin.json"),
);
assert(manifest.name === "synapse", "plugin name must match its directory");
assert(isValidSemver(manifest.version), "invalid plugin semver");
assert(
  typeof manifest.description === "string" && manifest.description,
  "missing description",
);
assert(manifest.author?.name, "missing author.name");
assert(manifest.interface?.displayName, "missing interface.displayName");
assert(
  manifest.interface?.shortDescription,
  "missing interface.shortDescription",
);
assert(
  manifest.interface?.longDescription,
  "missing interface.longDescription",
);
assert(manifest.interface?.developerName, "missing interface.developerName");
assert(manifest.interface?.category, "missing interface.category");
assert(
  Array.isArray(manifest.interface?.capabilities),
  "capabilities must be an array",
);
assert(manifest.mcpServers === "./.mcp.json", "manifest must expose .mcp.json");
assert(
  !Object.hasOwn(manifest, "hooks"),
  "default hooks/hooks.json must be discovered automatically",
);
assert(
  !JSON.stringify(manifest).includes("[TODO:"),
  "manifest contains a TODO placeholder",
);

const mcp = await readJson(resolve(pluginRoot, ".mcp.json"));
assert(
  Object.keys(mcp.mcpServers ?? {}).length === 1,
  "plugin must expose exactly one MCP server",
);
const memoryServer = mcp.mcpServers?.["synapse-memory"];
assert(
  memoryServer?.type === "http",
  "synapse-memory must use Streamable HTTP",
);
assert(
  !Object.hasOwn(memoryServer, "command"),
  "cloud MCP must not launch a local process",
);
assert(
  typeof memoryServer?.url === "string" &&
    new URL(memoryServer.url).protocol === "https:",
  "synapse-memory must use an HTTPS URL",
);
assert(
  memoryServer.oauth_resource === memoryServer.url,
  "OAuth resource must equal MCP URL",
);
assert(
  new URL(memoryServer.url).pathname === "/mcp",
  "MCP URL must use the exact /mcp path",
);
for (const file of await readdir(pluginRoot, { recursive: true })) {
  if (!file.endsWith(".mjs")) continue;
  const serverSource = await readFile(resolve(pluginRoot, file), "utf8");
  const runtimePackages = findRuntimePackageLoads(serverSource);
  assert(
    runtimePackages.length === 0,
    `${file} must not load runtime packages: ${runtimePackages.join(", ")}`,
  );
  for (const match of serverSource.matchAll(
    /(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g,
  )) {
    const target = resolve(dirname(resolve(pluginRoot, file)), match[1]);
    const relativeToPluginRoot = relative(pluginRoot, target);
    assert(
      relativeToPluginRoot !== "" &&
        !relativeToPluginRoot.startsWith("..") &&
        !isAbsolute(relativeToPluginRoot),
      `${file} imports outside the installed plugin`,
    );
    await access(target);
  }
}
assert(
  manifest.skills === "./skills",
  "plugin must expose bundled setup skill",
);
await access(resolve(pluginRoot, "skills/setup-synapse/SKILL.md"));
await access(resolve(pluginRoot, "scripts/setup.mjs"));

const hooks = (await readJson(resolve(pluginRoot, "hooks/hooks.json"))).hooks;
const windowsNodeCommand = (script) =>
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\${PLUGIN_ROOT}/scripts/run-node.ps1" "\${PLUGIN_ROOT}/hooks/${script}"`;
assert(
  hooks?.Stop?.[0]?.hooks?.[0]?.type === "command",
  "Stop must use the local scheduler",
);
assert(
  hooks.Stop[0].hooks[0].command ===
    `sh "\${PLUGIN_ROOT}/scripts/run-node.sh" "\${PLUGIN_ROOT}/hooks/checkpoint-memory.mjs"`,
  "Stop must launch the dependency-free checkpoint scheduler",
);
assert(
  hooks.Stop[0].hooks[0].commandWindows ===
    windowsNodeCommand("checkpoint-memory.mjs"),
  "Stop must use the Windows-native runtime launcher on Windows",
);
await access(resolve(pluginRoot, "hooks/checkpoint-memory.mjs"));
assert(
  hooks?.UserPromptSubmit?.[0]?.hooks?.some(
    (hook) =>
      hook.command ===
        `sh "\${PLUGIN_ROOT}/scripts/run-node.sh" "\${PLUGIN_ROOT}/hooks/prompt-memory.mjs"` &&
      hook.async !== true,
  ),
  "UserPromptSubmit must inject due memory saves privately",
);
assert(
  hooks?.UserPromptSubmit?.[0]?.hooks?.some(
    (hook) =>
      hook.commandWindows === windowsNodeCommand("prompt-memory.mjs") &&
      hook.async !== true,
  ),
  "UserPromptSubmit must inject memory through the Windows-native launcher",
);
await access(resolve(pluginRoot, "hooks/prompt-memory.mjs"));
assert(
  hooks?.SessionStart?.some(
    (entry) =>
      entry.matcher === "^startup$" &&
      entry.hooks?.some(
        (hook) =>
          hook.command ===
            `sh "\${PLUGIN_ROOT}/scripts/run-node.sh" "\${PLUGIN_ROOT}/hooks/bind-child.mjs"` &&
          hook.async === true,
      ),
  ),
  "SessionStart must bind delegated permanent task IDs in the child",
);
assert(
  hooks?.SessionStart?.some(
    (entry) =>
      entry.matcher === "^startup$" &&
      entry.hooks?.some(
        (hook) =>
          hook.commandWindows === windowsNodeCommand("bind-child.mjs") &&
          hook.async === true,
      ),
  ),
  "SessionStart must bind child tasks through the Windows-native launcher",
);
assert(
  hooks?.UserPromptSubmit?.[0]?.hooks?.some(
    (hook) =>
      hook.command === `sh "\${PLUGIN_ROOT}/hooks/run-dispatch.sh"` &&
      hook.async === true,
  ),
  "UserPromptSubmit must route Synapse tasks asynchronously through the signed desktop runtime",
);
assert(
  hooks?.UserPromptSubmit?.[0]?.hooks?.some(
    (hook) =>
      hook.commandWindows === windowsNodeCommand("dispatch.mjs") &&
      hook.async === true,
  ),
  "UserPromptSubmit must route tasks through the Windows-native launcher",
);
await access(resolve(pluginRoot, "scripts/run-node.ps1"));
await access(resolve(pluginRoot, "scripts/check-runtime.mjs"));
assert(
  hooks?.SessionStart?.some((entry) => entry.matcher === "^compact$"),
  "SessionStart must restore memory after compaction",
);
assert(
  !hooks.PreCompact && !hooks.SessionEnd,
  "unsupported recovery hooks must remain absent",
);

for (const event of [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
]) {
  assert(
    hooks[event]?.some((entry) =>
      entry.hooks?.some(
        (hook) =>
          hook.command ===
            `/bin/sh "\${PLUGIN_ROOT}/scripts/run-node.sh" "\${PLUGIN_ROOT}/hooks/conversation.mjs"` &&
          hook.async !== true,
      ),
    ),
    `${event} must run synchronous conversation tracking`,
  );
}
for (const event of ["SessionStart", "UserPromptSubmit"]) {
  assert(
    hooks[event]?.some((entry) =>
      entry.hooks?.some(
        (hook) =>
          hook.command.includes("/hooks/wake-receiver.mjs") && hook.async,
      ),
    ),
    `${event} must wake the supervised receiver`,
  );
}
for (const file of [
  "lib/conversation-store.mjs",
  "lib/conversation-hooks.mjs",
  "lib/native-queue.mjs",
  "lib/receiver-service.mjs",
  "lib/receiver-worker.mjs",
  "server/control.mjs",
]) {
  const loads = findRuntimePackageLoads(
    await readFile(resolve(pluginRoot, file), "utf8"),
  );
  assert(loads.length === 0, `${file} must remain dependency-free`);
}

const marketplacePath = resolve(
  repositoryRoot,
  ".agents/plugins/marketplace.json",
);
const marketplace = await readJson(marketplacePath);
const entry = marketplace.plugins?.find((plugin) => plugin.name === "synapse");
assert(
  marketplace.name === "synapse",
  "repository marketplace must be named synapse",
);
assert(entry?.source?.source === "local", "marketplace source must be local");
assert(
  entry?.source?.path === "./plugins/synapse",
  "marketplace source path is invalid",
);
assert(entry?.policy?.installation === "AVAILABLE", "plugin must be available");
assert(
  entry?.policy?.authentication === "ON_INSTALL",
  "plugin auth policy is invalid",
);

process.stdout.write(`Plugin validation passed: ${pluginRoot}\n`);
