import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectConversations } from "./conversation-doctor.mjs";

import {
  hostDatabasePath,
  PROJECT_ALIAS_PATTERN,
  resolveProjectRoot,
} from "./project-registry.mjs";

const execFileAsync = promisify(execFile);
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const MCP_SERVER_NAME = "synapse-memory";
export const PLUGIN_ID = "synapse@synapse";

export function canonicalPath(path) {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return resolve(path);
  }
}

async function runJson(runCommand, command, arguments_, options = {}) {
  const { stdout } = await runCommand(command, arguments_, {
    encoding: "utf8",
    ...options,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `${command} ${arguments_.join(" ")} returned invalid JSON; update Codex and retry`,
    );
  }
}

export function setupStatePath(env = process.env) {
  return resolve(
    env.SYNAPSE_SETUP_STATE ??
      resolve(dirname(hostDatabasePath(env)), "setup-state.json"),
  );
}

export async function readSetupState(env = process.env) {
  try {
    const state = JSON.parse(await readFile(setupStatePath(env), "utf8"));
    return state?.version === 1 ? state : null;
  } catch {
    return null;
  }
}

export async function readPluginConfiguration(repositoryRoot = moduleRoot) {
  const config = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "plugins/synapse/.mcp.json"),
      "utf8",
    ),
  );
  const server = config.mcpServers?.[MCP_SERVER_NAME];
  if (!server?.url) {
    throw new Error(`Plugin does not configure ${MCP_SERVER_NAME}`);
  }
  return server;
}

export async function readPluginManifest(repositoryRoot = moduleRoot) {
  return JSON.parse(
    await readFile(
      resolve(repositoryRoot, "plugins/synapse/.codex-plugin/plugin.json"),
      "utf8",
    ),
  );
}

export function inspectProjectBinding(
  { root, alias },
  { env = process.env } = {},
) {
  const path = hostDatabasePath(env);
  if (!existsSync(path)) {
    return {
      status: "fail",
      summary: "Project is not connected",
      detail: `No Synapse project registry exists at ${path}`,
      remedy: `Run setup --alias ${alias ?? "<cloud-project-alias>"}`,
    };
  }
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const hasProjects = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
      )
      .get();
    if (!hasProjects) throw new Error("projects table is missing");
    const row = database
      .prepare("SELECT alias, root FROM projects WHERE root = ?")
      .get(root);
    if (!row) {
      return {
        status: "fail",
        summary: "Project is not connected",
        detail: `${root} has no local cloud-project alias binding`,
        remedy: `Run setup --alias ${alias ?? "<cloud-project-alias>"} ${root}`,
      };
    }
    if (alias && row.alias !== alias) {
      return {
        status: "fail",
        summary: `Project is connected as ${row.alias}, not ${alias}`,
        detail:
          "Synapse preserves existing aliases and will not overwrite this binding.",
        remedy: "Use the cloud alias already bound to this checkout.",
      };
    }
    return {
      status: "pass",
      summary: `Project is connected as ${row.alias}`,
      detail: root,
    };
  } catch (error) {
    return {
      status: "fail",
      summary: "Project registry cannot be read",
      detail: error.message,
      remedy: `Inspect ${path}; doctor never repairs or replaces it.`,
    };
  } finally {
    database?.close();
  }
}

function marketplaceCheck(marketplaces, repositoryRoot) {
  const entry = marketplaces.marketplaces?.find(
    (marketplace) => marketplace.name === "synapse",
  );
  if (!entry) {
    return {
      status: "fail",
      summary: "Synapse marketplace is not configured",
      detail:
        "Distribution currently requires access to a local checkout of the private repository.",
      remedy: "Run setup from the authorized Synapse checkout.",
    };
  }
  const configuredRoot = canonicalPath(
    entry.marketplaceSource?.source ?? entry.root,
  );
  if (configuredRoot !== canonicalPath(repositoryRoot)) {
    return {
      status: "fail",
      summary: "Synapse marketplace points at another checkout",
      detail: configuredRoot,
      remedy:
        "Use setup from that checkout, or deliberately update the marketplace outside doctor.",
    };
  }
  return {
    status: "pass",
    summary: "Synapse marketplace is configured",
    detail: configuredRoot,
  };
}

function pluginCheck(plugins, expectedPlugin, repositoryRoot) {
  const plugin = plugins.installed?.find(
    (candidate) => candidate.pluginId === PLUGIN_ID,
  );
  if (!plugin) {
    return {
      status: "fail",
      summary: "Synapse plugin is not installed",
      remedy: "Run setup to install synapse@synapse.",
    };
  }
  if (!plugin.enabled) {
    return {
      status: "fail",
      summary: "Synapse plugin is installed but disabled",
      detail: plugin.version,
      remedy: "Enable the installed plugin in Codex, then rerun doctor.",
    };
  }
  if (plugin.version !== expectedPlugin.version) {
    return {
      status: "fail",
      summary: `Synapse plugin ${plugin.version} is stale`,
      detail: `This checkout provides ${expectedPlugin.version}`,
      remedy: "Run setup to refresh the installed plugin.",
    };
  }
  const expectedSource = canonicalPath(
    resolve(repositoryRoot, "plugins/synapse"),
  );
  if (
    !plugin.source?.path ||
    canonicalPath(plugin.source.path) !== expectedSource
  ) {
    return {
      status: "fail",
      summary: "Synapse plugin comes from another source",
      detail: plugin.source?.path ?? "Codex did not report a source path",
      remedy: "Use setup from the checkout that owns the installed plugin.",
    };
  }
  return {
    status: "pass",
    summary: `Synapse plugin ${plugin.version} is installed and enabled`,
    detail: plugin.source?.path,
  };
}

function oauthCheck(servers, expectedServer, setupState) {
  const server = servers.find(
    (candidate) => candidate.name === MCP_SERVER_NAME,
  );
  if (!server) {
    return {
      status: "fail",
      summary: `${MCP_SERVER_NAME} is not configured in Codex`,
      remedy: "Run setup after installing the Synapse plugin.",
    };
  }
  if (!server.enabled || server.transport?.url !== expectedServer.url) {
    return {
      status: "fail",
      summary: `${MCP_SERVER_NAME} is disabled or points at the wrong resource`,
      detail: server.transport?.url,
      remedy:
        "Reinstall the authorized plugin configuration, then rerun setup.",
    };
  }
  const authStatus = String(server.auth_status ?? "")
    .toLowerCase()
    .replaceAll("_", "");
  if (authStatus !== "oauth") {
    return {
      status: "fail",
      summary: `${MCP_SERVER_NAME} is not configured for OAuth`,
      detail: server.auth_status ?? "unknown auth mode",
      remedy: "Update Codex and reinstall the Synapse plugin.",
    };
  }
  const receipt = setupState?.oauth;
  if (
    receipt?.server === MCP_SERVER_NAME &&
    receipt?.resource === expectedServer.url &&
    typeof receipt.completedAt === "string"
  ) {
    return {
      status: "pass",
      summary: `OAuth login completed at ${receipt.completedAt}`,
      detail:
        "The receipt contains no token. Confirm live access with get_identity in a new Codex task.",
    };
  }
  return {
    status: "warn",
    summary: "OAuth is configured, but no successful-login receipt exists",
    detail:
      "Codex does not expose live OAuth token validity through its read-only MCP list command.",
    remedy: "Run setup to log in, then confirm live access with get_identity.",
  };
}

export async function runDoctor(
  { project = ".", alias, cwd = process.cwd() } = {},
  {
    env = process.env,
    repositoryRoot = moduleRoot,
    runCommand = execFileAsync,
    resolveRoot = resolveProjectRoot,
    conversationDoctor = inspectConversations,
  } = {},
) {
  const normalizedAlias = alias
    ? String(alias).trim().toLowerCase()
    : undefined;
  if (normalizedAlias && !PROJECT_ALIAS_PATTERN.test(normalizedAlias)) {
    return {
      ok: false,
      checks: [
        {
          id: "project",
          status: "fail",
          summary:
            "Project alias must be 2-63 lowercase characters starting with a letter",
        },
      ],
    };
  }
  let root;
  try {
    root = await resolveRoot(project, cwd);
  } catch (error) {
    return {
      ok: false,
      checks: [
        {
          id: "project",
          status: "fail",
          summary: error.message,
          remedy: "Pass an absolute path to a primary Git checkout.",
        },
      ],
    };
  }

  const [expectedServer, expectedPlugin] = await Promise.all([
    readPluginConfiguration(repositoryRoot),
    readPluginManifest(repositoryRoot),
  ]);
  let version;
  let marketplaces;
  let plugins;
  let servers;
  try {
    ({ stdout: version } = await runCommand("codex", ["--version"], {
      encoding: "utf8",
    }));
    [marketplaces, plugins, servers] = await Promise.all([
      runJson(runCommand, "codex", ["plugin", "marketplace", "list", "--json"]),
      runJson(runCommand, "codex", ["plugin", "list", "--json"]),
      runJson(runCommand, "codex", ["mcp", "list", "--json"]),
    ]);
  } catch (error) {
    return {
      ok: false,
      checks: [
        {
          id: "codex",
          status: "fail",
          summary: "Codex CLI diagnostics failed",
          detail: error.message,
          remedy: "Install or update Codex, then retry.",
        },
      ],
    };
  }

  const checks = [
    {
      id: "codex",
      status: "pass",
      summary: version.trim(),
    },
    {
      id: "marketplace",
      ...marketplaceCheck(marketplaces, repositoryRoot),
    },
    {
      id: "plugin",
      ...pluginCheck(plugins, expectedPlugin, repositoryRoot),
    },
    {
      id: "oauth",
      ...oauthCheck(servers, expectedServer, await readSetupState(env)),
    },
    {
      id: "project",
      ...inspectProjectBinding({ root, alias: normalizedAlias }, { env }),
    },
  ];
  const conversations = await conversationDoctor(
    { root, repositoryRoot },
    { env },
  );
  checks.push(...conversations.checks);
  return {
    conversations_ready: conversations.ready,
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

export function formatDoctorReport(report) {
  const marker = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const lines = report.checks.flatMap((check) => {
    const output = [`[${marker[check.status]}] ${check.id}: ${check.summary}`];
    if (check.detail) output.push(`  ${check.detail}`);
    if (check.remedy) output.push(`  Next: ${check.remedy}`);
    return output;
  });
  lines.push(
    report.ok ? "Synapse setup is ready." : "Synapse setup needs attention.",
  );
  return `${lines.join("\n")}\n`;
}
