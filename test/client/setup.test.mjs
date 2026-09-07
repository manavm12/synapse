import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  formatDoctorReport,
  inspectProjectBinding,
  runDoctor,
  setupStatePath,
} from "../../src/client/doctor.mjs";
import { connectProject } from "../../src/client/project-registry.mjs";
import { formatSetupResult, runSetup } from "../../src/client/setup.mjs";

const repositoryRoot = resolve(".");
const mcpUrl = "https://synapse-production-ff6c.up.railway.app/mcp";
const pluginVersion = JSON.parse(
  await readFile(
    join(repositoryRoot, "plugins/synapse/.codex-plugin/plugin.json"),
    "utf8",
  ),
).version;

function json(value) {
  return { stdout: JSON.stringify(value) };
}

function createCodexRunner() {
  const calls = [];
  let marketplaceInstalled = false;
  let pluginInstalled = false;
  const runCommand = async (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    const key = arguments_.join(" ");
    if (key === "--version") return { stdout: "codex-cli 0.152.0\n" };
    if (key === "plugin marketplace list --json") {
      return json({
        marketplaces: marketplaceInstalled
          ? [
              {
                name: "synapse",
                root: repositoryRoot,
                marketplaceSource: {
                  sourceType: "local",
                  source: repositoryRoot,
                },
              },
            ]
          : [],
      });
    }
    if (key.startsWith("plugin marketplace add ")) {
      marketplaceInstalled = true;
      return json({ marketplaceName: "synapse" });
    }
    if (key === "plugin list --json") {
      return json({
        installed: pluginInstalled
          ? [
              {
                pluginId: "synapse@synapse",
                version: pluginVersion,
                installed: true,
                enabled: true,
                source: { path: join(repositoryRoot, "plugins/synapse") },
              },
            ]
          : [],
      });
    }
    if (key === "plugin add synapse@synapse --json") {
      pluginInstalled = true;
      return json({ pluginId: "synapse@synapse" });
    }
    if (key === "mcp list --json") {
      return json([
        {
          name: "synapse-memory",
          enabled: true,
          transport: { type: "streamable_http", url: mcpUrl },
          auth_status: "o_auth",
        },
      ]);
    }
    if (key === "mcp login synapse-memory") return { stdout: "" };
    throw new Error(`Unexpected command: ${command} ${key}`);
  };
  return { calls, runCommand };
}

test("setup completes missing stages and a rerun preserves completed state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-setup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { SYNAPSE_HOME: join(directory, "state") };
  const projectRoot = join(directory, "project");
  await mkdir(env.SYNAPSE_HOME, { recursive: true });
  await writeFile(
    setupStatePath(env),
    `${JSON.stringify({ version: 1, future: { preserved: true } })}\n`,
  );
  const runner = createCodexRunner();
  const connections = [];
  let connected = false;
  const dependencies = {
    env,
    repositoryRoot,
    runCommand: runner.runCommand,
    resolveRoot: async () => projectRoot,
    connect: async (input, options) => {
      connections.push({ input, options });
      const created = !connected;
      connected = true;
      return { ...input, root: projectRoot, created };
    },
    now: () => Date.parse("2026-09-07T12:00:00.000Z"),
  };

  const first = await runSetup(
    { project: projectRoot, alias: "Demo", cwd: directory },
    dependencies,
  );
  assert.deepEqual(
    first.steps.map(({ id, changed }) => [id, changed]),
    [
      ["marketplace", true],
      ["plugin", true],
      ["oauth", true],
      ["project", true],
    ],
  );
  assert.equal(first.alias, "demo");
  assert.match(formatSetupResult(first), /Synapse setup is ready/);
  assert.equal(connections[0].options.env, env);
  const state = JSON.parse(await readFile(setupStatePath(env), "utf8"));
  assert.deepEqual(state, {
    version: 1,
    future: { preserved: true },
    oauth: {
      server: "synapse-memory",
      resource: mcpUrl,
      completedAt: "2026-09-07T12:00:00.000Z",
    },
  });
  assert.equal((await stat(setupStatePath(env))).mode & 0o777, 0o600);

  const second = await runSetup(
    { project: projectRoot, alias: "demo", cwd: directory },
    dependencies,
  );
  assert.deepEqual(
    second.steps.map(({ id, changed }) => [id, changed]),
    [
      ["marketplace", false],
      ["plugin", false],
      ["oauth", false],
      ["project", false],
    ],
  );
  assert.equal(
    runner.calls.filter(
      ({ arguments_ }) => arguments_.join(" ") === "mcp login synapse-memory",
    ).length,
    1,
  );
});

test("setup validates the project before invoking or changing Codex", async () => {
  let invoked = false;
  await assert.rejects(
    () =>
      runSetup(
        { alias: "demo" },
        {
          resolveRoot: async () => {
            throw new Error("Project must be its primary checkout");
          },
          runCommand: async () => {
            invoked = true;
          },
        },
      ),
    /primary checkout/,
  );
  assert.equal(invoked, false);
});

test("setup preserves an existing marketplace with another source", async () => {
  const runCommand = async (_command, arguments_) => {
    const key = arguments_.join(" ");
    if (key === "--version") return { stdout: "codex-cli 0.152.0" };
    if (key === "plugin marketplace list --json") {
      return json({
        marketplaces: [
          {
            name: "synapse",
            marketplaceSource: {
              sourceType: "local",
              source: "/another/checkout",
            },
          },
        ],
      });
    }
    throw new Error("should not change Codex config");
  };
  await assert.rejects(
    () =>
      runSetup(
        { alias: "demo" },
        { runCommand, resolveRoot: async () => "/project" },
      ),
    /Existing Codex config was preserved/,
  );
});

test("doctor reads installation, OAuth receipt, and project binding without writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-doctor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { SYNAPSE_HOME: join(directory, "state") };
  const projectRoot = join(directory, "project");
  await connectProject(
    { alias: "demo", project: projectRoot },
    { env, resolveRoot: async () => projectRoot },
  );
  const runner = createCodexRunner();
  await runner.runCommand("codex", [
    "plugin",
    "marketplace",
    "add",
    repositoryRoot,
    "--json",
  ]);
  await runner.runCommand("codex", [
    "plugin",
    "add",
    "synapse@synapse",
    "--json",
  ]);
  await runSetup(
    { alias: "demo", project: projectRoot },
    {
      env,
      repositoryRoot,
      runCommand: runner.runCommand,
      resolveRoot: async () => projectRoot,
      connect: async () => ({ created: false }),
    },
  );
  const databasePath = join(directory, "state", "host.sqlite");
  const before = await stat(databasePath);
  const report = await runDoctor(
    { alias: "demo", project: projectRoot },
    {
      env,
      repositoryRoot,
      runCommand: runner.runCommand,
      resolveRoot: async () => projectRoot,
    },
  );
  const after = await stat(databasePath);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map(({ id, status }) => [id, status]),
    [
      ["codex", "pass"],
      ["marketplace", "pass"],
      ["plugin", "pass"],
      ["oauth", "pass"],
      ["project", "pass"],
    ],
  );
  assert.match(formatDoctorReport(report), /Synapse setup is ready/);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("doctor reports missing OAuth evidence and missing registry without creating either", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-doctor-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { SYNAPSE_HOME: join(directory, "state") };
  const runner = createCodexRunner();
  await runner.runCommand("codex", [
    "plugin",
    "marketplace",
    "add",
    repositoryRoot,
    "--json",
  ]);
  await runner.runCommand("codex", [
    "plugin",
    "add",
    "synapse@synapse",
    "--json",
  ]);
  const report = await runDoctor(
    { project: "/project" },
    {
      env,
      repositoryRoot,
      runCommand: runner.runCommand,
      resolveRoot: async () => "/project",
    },
  );
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(({ id }) => id === "oauth").status, "warn");
  assert.equal(report.checks.find(({ id }) => id === "project").status, "fail");
  assert.equal(
    inspectProjectBinding({ root: "/project" }, { env }).status,
    "fail",
  );
  await assert.rejects(() => stat(join(directory, "state")), /ENOENT/);
});

test("doctor normalizes the requested alias before checking its existing binding", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-doctor-alias-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { SYNAPSE_HOME: join(directory, "state") };
  const projectRoot = join(directory, "project");
  await connectProject(
    { alias: "demo", project: projectRoot },
    { env, resolveRoot: async () => projectRoot },
  );
  const runner = createCodexRunner();
  await runner.runCommand("codex", [
    "plugin",
    "marketplace",
    "add",
    repositoryRoot,
    "--json",
  ]);
  await runner.runCommand("codex", [
    "plugin",
    "add",
    "synapse@synapse",
    "--json",
  ]);
  const report = await runDoctor(
    { alias: " Demo ", project: projectRoot },
    {
      env,
      repositoryRoot,
      runCommand: runner.runCommand,
      resolveRoot: async () => projectRoot,
    },
  );
  assert.equal(report.checks.find(({ id }) => id === "project").status, "pass");
});
