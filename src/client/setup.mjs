import { execFile } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  canonicalPath,
  MCP_SERVER_NAME,
  PLUGIN_ID,
  readPluginConfiguration,
  readPluginManifest,
  readSetupState,
  setupStatePath,
} from "./doctor.mjs";
import {
  connectProject,
  PROJECT_ALIAS_PATTERN,
  resolveProjectRoot,
} from "./project-registry.mjs";

const execFileAsync = promisify(execFile);
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function runJson(runCommand, arguments_) {
  const { stdout } = await runCommand("codex", arguments_, {
    encoding: "utf8",
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `codex ${arguments_.join(" ")} returned invalid JSON; update Codex and retry`,
    );
  }
}

function canonicalAlias(alias) {
  const normalized = String(alias ?? "")
    .trim()
    .toLowerCase();
  if (!PROJECT_ALIAS_PATTERN.test(normalized)) {
    throw new Error(
      "Project alias must be 2-63 lowercase characters starting with a letter",
    );
  }
  return normalized;
}

async function recordOAuthLogin(env, expectedServer, now) {
  const path = setupStatePath(env);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const current = (await readSetupState(env)) ?? {};
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        ...current,
        version: 1,
        oauth: {
          server: MCP_SERVER_NAME,
          resource: expectedServer.url,
          completedAt: new Date(now()).toISOString(),
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export async function runSetup(
  { project = ".", alias, cwd = process.cwd(), forceLogin = false } = {},
  {
    env = process.env,
    repositoryRoot = moduleRoot,
    runCommand = execFileAsync,
    resolveRoot = resolveProjectRoot,
    connect = connectProject,
    now = () => Date.now(),
  } = {},
) {
  const normalizedAlias = canonicalAlias(alias);
  const root = await resolveRoot(project, cwd);
  const [expectedServer, expectedPlugin] = await Promise.all([
    readPluginConfiguration(repositoryRoot),
    readPluginManifest(repositoryRoot),
  ]);
  const steps = [];

  try {
    await runCommand("codex", ["--version"], { encoding: "utf8" });
  } catch {
    throw new Error("Codex CLI is required; install or update Codex and retry");
  }

  const marketplaces = await runJson(runCommand, [
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  const marketplace = marketplaces.marketplaces?.find(
    (candidate) => candidate.name === "synapse",
  );
  if (marketplace) {
    const configured = canonicalPath(
      marketplace.marketplaceSource?.source ?? marketplace.root,
    );
    if (configured !== canonicalPath(repositoryRoot)) {
      throw new Error(
        `The Synapse marketplace already points at ${configured}. Existing Codex config was preserved; run setup from that authorized checkout or update it deliberately.`,
      );
    }
    steps.push({ id: "marketplace", changed: false });
  } else {
    await runJson(runCommand, [
      "plugin",
      "marketplace",
      "add",
      resolve(repositoryRoot),
      "--json",
    ]);
    steps.push({ id: "marketplace", changed: true });
  }

  let plugins = await runJson(runCommand, ["plugin", "list", "--json"]);
  let plugin = plugins.installed?.find(
    (candidate) => candidate.pluginId === PLUGIN_ID,
  );
  if (
    plugin &&
    (!plugin.source?.path ||
      canonicalPath(plugin.source.path) !==
        canonicalPath(resolve(repositoryRoot, "plugins/synapse")))
  ) {
    throw new Error(
      `The installed Synapse plugin comes from ${plugin.source?.path ?? "an unknown source"}. Existing Codex config was preserved; use setup from that checkout or update the installation deliberately.`,
    );
  }
  if (!plugin || plugin.version !== expectedPlugin.version) {
    await runJson(runCommand, ["plugin", "add", PLUGIN_ID, "--json"]);
    steps.push({ id: "plugin", changed: true });
    plugins = await runJson(runCommand, ["plugin", "list", "--json"]);
    plugin = plugins.installed?.find(
      (candidate) => candidate.pluginId === PLUGIN_ID,
    );
  } else {
    steps.push({ id: "plugin", changed: false });
  }
  if (!plugin?.enabled) {
    throw new Error(
      "Synapse is installed but disabled. Existing Codex config was preserved; enable the plugin and rerun setup.",
    );
  }
  if (plugin.version !== expectedPlugin.version) {
    throw new Error(
      `Codex still reports Synapse ${plugin.version}; expected ${expectedPlugin.version}. Update Codex or refresh the plugin installation, then retry.`,
    );
  }

  const servers = await runJson(runCommand, ["mcp", "list", "--json"]);
  const server = servers.find(
    (candidate) => candidate.name === MCP_SERVER_NAME,
  );
  if (
    !server?.enabled ||
    server.transport?.url !== expectedServer.url ||
    String(server.auth_status).toLowerCase().replaceAll("_", "") !== "oauth"
  ) {
    throw new Error(
      `${MCP_SERVER_NAME} is missing, disabled, or does not match ${expectedServer.url}. Existing Codex config was preserved; reinstall the authorized plugin and retry.`,
    );
  }

  const state = await readSetupState(env);
  const loginRecorded =
    state?.oauth?.server === MCP_SERVER_NAME &&
    state?.oauth?.resource === expectedServer.url;
  if (!loginRecorded || forceLogin) {
    try {
      await runCommand("codex", ["mcp", "login", MCP_SERVER_NAME], {
        stdio: "inherit",
      });
    } catch {
      throw new Error(
        "OAuth login did not complete. Alpha access requires an allowed email; Supabase's built-in sender reaches project-team addresses only unless custom SMTP is configured. Retry setup after resolving access or mail delivery.",
      );
    }
    await recordOAuthLogin(env, expectedServer, now);
    steps.push({ id: "oauth", changed: true });
  } else {
    steps.push({ id: "oauth", changed: false });
  }

  const binding = await connect(
    { alias: normalizedAlias, project: root, cwd },
    { env, resolveRoot: async () => root },
  );
  steps.push({ id: "project", changed: binding.created });
  return { root, alias: normalizedAlias, steps };
}

export function formatSetupResult(result) {
  const label = (step) => (step.changed ? "completed" : "already complete");
  return `${[
    `Marketplace: ${label(result.steps.find((step) => step.id === "marketplace"))}`,
    `Plugin: ${label(result.steps.find((step) => step.id === "plugin"))}`,
    `OAuth login: ${label(result.steps.find((step) => step.id === "oauth"))}`,
    `Project binding: ${label(result.steps.find((step) => step.id === "project"))}`,
    `Synapse setup is ready for ${result.alias} at ${result.root}.`,
    "Start a new Codex task and call get_identity to verify live OAuth access.",
  ].join("\n")}\n`;
}
