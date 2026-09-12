import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { recordSession } from "../../plugins/synapse/lib/conversation-store.mjs";
import {
  readHookInput,
  sessionRegistration,
} from "../../plugins/synapse/lib/hook-context.mjs";
import { withInbox } from "../../plugins/synapse/lib/inbox.mjs";
import {
  receiverServicePlist,
  receiverServicePowerShell,
  receiverServiceStatus,
  receiverServiceSystemd,
  startReceiverService,
  stopReceiverService,
} from "../../plugins/synapse/lib/receiver-service.mjs";
import { inspectConversations } from "../../src/client/conversation-doctor.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "synapse-supervisor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inboxOptions = { path: join(root, "inbox.sqlite") };
  const options = {
    inboxOptions,
    platform: "darwin",
    userHome: root,
    uid: 1234,
    nodePath: process.execPath,
    env: {},
  };
  return { root, inboxOptions, options };
}

test("LaunchAgent lifecycle is scoped, idempotent, private and fenced against automatic restart after stop", async (t) => {
  const f = await fixture(t);
  assert.equal(receiverServiceStatus({}, f).runtime_registered, false);
  assert.equal(existsSync(f.inboxOptions.path), false);
  let loaded = false;
  const calls = [];
  f.options.run = async (_, args) => {
    calls.push(args);
    if (args[0] === "print" && !loaded) throw new Error("not loaded");
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
  };
  assert.equal((await startReceiverService({}, f.options)).started, true);
  assert.equal((await startReceiverService({}, f.options)).unchanged, true);
  const path = join(f.root, "Library/LaunchAgents/com.synapse.receiver.plist");
  const plist = await readFile(path, "utf8");
  assert.match(plist, /server[\\/]receiver\.mjs/);
  assert.match(plist, /KeepAlive/);
  assert.equal(calls.filter((c) => c[0] === "bootstrap").length, 1);
  await writeFile(path, "older version");
  await startReceiverService({}, f.options);
  assert.equal(calls.filter((c) => c[0] === "bootstrap").length, 2);
  assert.equal((await stopReceiverService({}, f.options)).stopped, true);
  assert.equal(receiverServiceStatus({}, f).stopped, true);
  assert.equal(
    (await startReceiverService({ automatic: true }, f.options)).paused,
    true,
  );
  assert.equal(existsSync(path), false);
  await startReceiverService({}, f.options);
  assert.equal(receiverServiceStatus({}, f).stopped, false);
  const safe = receiverServicePlist({
    nodePath: "/A&B/node",
    stateDirectory: f.root,
    env: { SYNAPSE_HOME: "/private/<local>", SECRET_TOKEN: "never-copy" },
  });
  assert.match(safe, /A&amp;B/);
  assert.doesNotMatch(safe, /SECRET_TOKEN|never-copy/);
});

test("supervisor rejects unsupported runtimes, serializes concurrent starts, and stops absent jobs", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    startReceiverService({}, { ...f.options, platform: "aix" }),
    /not supported/,
  );
  await assert.rejects(
    startReceiverService({}, { ...f.options, nodePath: "/missing" }),
    /signed desktop runtime/,
  );
  const gate = Promise.withResolvers();
  const first = startReceiverService(
    {},
    {
      ...f.options,
      run: async () => {
        await gate.promise;
        throw new Error("not loaded");
      },
    },
  );
  assert.equal((await startReceiverService({}, f.options)).starting, true);
  gate.resolve();
  await assert.rejects(first, /not loaded/);
  assert.equal(
    (
      await stopReceiverService(
        {},
        {
          ...f.options,
          run: async () => {
            throw new Error("absent");
          },
        },
      )
    ).stopped,
    true,
  );
  await assert.rejects(
    stopReceiverService(
      {},
      {
        ...f.options,
        run: async (_, args) => {
          if (args[0] === "bootout") throw new Error("denied");
        },
      },
    ),
    /denied/,
  );
});

test("Windows Task Scheduler and Linux systemd user services are generated safely", async (t) => {
  const f = await fixture(t);
  const windowsCalls = [];
  const windows = {
    ...f.options,
    platform: "win32",
    run: async (_command, args) => {
      windowsCalls.push(args);
      if (args.includes("status")) throw new Error("missing");
    },
  };
  assert.equal((await startReceiverService({}, windows)).started, true);
  const launcher = join(f.root, "receiver-service.ps1");
  assert.match(await readFile(launcher, "utf8"), /server\\receiver\.mjs/);
  assert.equal(windowsCalls.some((args) => args.includes("start")), true);
  assert.equal((await stopReceiverService({}, windows)).stopped, true);
  assert.equal(existsSync(launcher), false);

  const linuxCalls = [];
  const linux = {
    ...f.options,
    platform: "linux",
    run: async (_command, args) => {
      linuxCalls.push(args);
      if (args.includes("is-active")) throw new Error("inactive");
    },
  };
  assert.equal((await startReceiverService({}, linux)).started, true);
  const unit = join(f.root, ".config/systemd/user/synapse-receiver.service");
  assert.match(await readFile(unit, "utf8"), /Restart=always/);
  assert.equal(linuxCalls.some((args) => args.includes("enable")), true);
  assert.equal((await stopReceiverService({}, linux)).stopped, true);
  assert.equal(existsSync(unit), false);

  const safeWindows = receiverServicePowerShell({ nodePath: "C:\\A'B\\node.exe", stateDirectory: f.root, env: { SYNAPSE_HOME: "C:\\private", SECRET_TOKEN: "never-copy" } });
  const safeLinux = receiverServiceSystemd({ nodePath: "/A B/node", stateDirectory: f.root, env: { SYNAPSE_HOME: "/private", SECRET_TOKEN: "never-copy" } });
  assert.doesNotMatch(`${safeWindows}${safeLinux}`, /SECRET_TOKEN|never-copy/);
});

test("doctor verifies signed access and queue readiness without changing inbox state", async (t) => {
  const f = await fixture(t);
  const env = { SYNAPSE_INBOX_PATH: f.inboxOptions.path };
  const target = { root: f.root, repositoryRoot: resolve(".") };
  assert.equal((await inspectConversations(target, { env })).ready, false);
  assert.equal(existsSync(f.inboxOptions.path), false);
  withInbox((db) => {
    recordSession(db, {
      sessionId: "source",
      cwd: f.root,
      projectRoot: f.root,
      pipePath: f.root,
      nodePath: process.execPath,
      codexPath: "/fixture/codex",
    });
    db.prepare(
      "INSERT INTO receiver_workers(name,lease_expires_at) VALUES ('receiver',?)",
    ).run(Date.now() + 30_000);
  }, f.inboxOptions);
  const before = await readFile(f.inboxOptions.path);
  const healthy = await inspectConversations(target, {
    env,
    run: async () => ({ stdout: '["create_thread","list_projects"]' }),
    queueClient: () => ({ async prepare() {}, close() {} }),
  });
  assert.equal(healthy.ready, true);
  assert.deepEqual(await readFile(f.inboxOptions.path), before);
  const offline = await inspectConversations(target, {
    env,
    run: async () => {
      throw new Error("unavailable");
    },
    queueClient: () => ({
      async prepare() {
        throw new Error("missing socket");
      },
      close() {},
    }),
  });
  assert.equal(offline.ready, false);
  assert.equal(offline.checks.filter((c) => c.status === "fail").length, 2);
});

test("hook inputs are bounded and runtime registration uses the primary checkout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-runtime-checkouts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const primary = join(directory, "primary");
  const linked = join(directory, "linked");
  execFileSync("git", ["init", primary], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      primary,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { stdio: "ignore" },
  );
  execFileSync("git", ["-C", primary, "worktree", "add", "--detach", linked], {
    stdio: "ignore",
  });
  const input = {
    session_id: "task",
    cwd: primary,
    hook_event_name: "SessionStart",
  };
  assert.deepEqual(
    await readHookInput(Readable.from([JSON.stringify(input)])),
    input,
  );
  assert.equal(
    await readHookInput(Readable.from(['{"session_id":"bad/id"}'])),
    null,
  );
  await assert.rejects(
    readHookInput(Readable.from(["x".repeat(1024 * 1024 + 1)])),
    /too large/,
  );
  for (const cwd of [primary, linked]) {
    const session = sessionRegistration(
      { ...input, cwd },
      {
        CODEX_MCP_NODE_PATH: process.execPath,
        CODEX_APP_TOOLS_PIPE_PATH: "/fixture/socket",
        SYNAPSE_CODEX_PATH: "/fixture/codex",
      },
    );
    assert.equal(session.projectRoot, realpathSync(primary));
    assert.equal(session.cwd, cwd);
    assert.equal(session.codexPath, "/fixture/codex");
    assert.equal(session.event, "SessionStart");
  }
});
