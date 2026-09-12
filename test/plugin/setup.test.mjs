import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { withDeadline } from "../../plugins/synapse/lib/deadline.mjs";
import {
  dispatchPrompt,
  isDeliveryPrompt,
} from "../../plugins/synapse/lib/dispatch.mjs";
import {
  promptHookHealth,
  recordPromptHook,
} from "../../plugins/synapse/lib/hook-health.mjs";
import {
  acceptProvisioning,
  acknowledgeMessage,
  confirmCloudImport,
  getJob,
  getReservedDelivery,
  markNativeMutationIssued,
  markNativeMutationUncertain,
  queueMessage,
  stageCloudMessage,
} from "../../plugins/synapse/lib/inbox.mjs";
import { formatDeliveryMarker } from "../../plugins/synapse/lib/markers.mjs";
import {
  routeDelivery,
  runReservedDelivery,
} from "../../plugins/synapse/lib/native-router.mjs";
import {
  activateDestination,
  activeDestinations,
  deactivateDestination,
  deferSetup,
  offerSetupOnce,
  readPromptReceipt,
  savePromptReceipt,
  setupConnections,
  withReceiverLease,
} from "../../plugins/synapse/lib/onboarding-state.mjs";
import {
  completeSetup,
  configuredReceiverServer,
  disableSetup,
  prepareSetup,
  primaryProject,
  savedProject,
  setupIdentity,
  setupStatus,
  validateSetupPairing,
} from "../../plugins/synapse/lib/plugin-setup.mjs";
import { ReceiverHttpError } from "../../plugins/synapse/lib/receiver-client.mjs";
import {
  cloudChannelId,
  messageContentHash,
} from "../../plugins/synapse/lib/receiver-contract.mjs";
import {
  getReceiverConnectionById,
  markReceiverDisconnecting,
} from "../../plugins/synapse/lib/receiver-registry.mjs";

test("first Keychain write failure remains resumable without publishing or remotely revoking its hash", async (t) => {
  const f = await fixture(t);
  let sets = 0;
  const baseSet = f.options.secretStore.set;
  f.options.secretStore.set = async (...args) => {
    if (sets++ === 0) throw new Error("Keychain denied");
    return baseSet(...args);
  };
  f.options.createClient = () =>
    assert.fail("unpublished hash must not contact server");
  await assert.rejects(f.prepare, /Keychain denied/);
  const prepared = await f.prepare();
  assert.equal(prepared.status, "approval_required");
  assert.equal(f.secrets.size, 1);
});

test("disable before cloud pairing accepts definitive credential absence and cleans up", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  f.options.createClient = () => ({
    async disconnect() {
      throw new ReceiverHttpError("absent", {
        status: 401,
        code: "unauthorized",
      });
    },
  });
  assert.equal(
    (await disableSetup({ connection_id: prepared.connection_id }, f.options))
      .status,
    "disabled",
  );
  assert.equal(f.secrets.size, 0);
  assert.equal((await f.prepare()).status, "approval_required");
});

test("transient verification and status cancellation never recommend destructive reconnect", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  await completeSetup(
    { connection_id: prepared.connection_id, pairing: f.pairing() },
    f.options,
  );
  const offline = {
    ...f.options,
    createClient: () => ({
      async getIdentity() {
        throw new Error("offline");
      },
    }),
  };
  assert.equal(
    (await prepareSetup({ identity }, offline)).status,
    "unavailable",
  );
  assert.equal(
    (await setupStatus({ connection_id: prepared.connection_id }, offline))
      .status,
    "unavailable",
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    () =>
      setupStatus(
        { connection_id: prepared.connection_id },
        { ...offline, signal: controller.signal },
      ),
    /cancelled/,
  );
  assert.equal(f.secrets.size, 1);
});

test("setup helper accepts one JSON line without waiting for terminal EOF", async (t) => {
  const f = await fixture(t);
  const child = spawn(
    "/bin/sh",
    [
      resolve("plugins/synapse/scripts/run-node.sh"),
      resolve("plugins/synapse/scripts/setup.mjs"),
    ],
    {
      env: {
        PATH: "/no-node",
        CODEX_MCP_NODE_PATH: process.execPath,
        SYNAPSE_HOST_DB: f.options.registryPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill());
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.write('{"action":"inspect"}\n');
  const [code] = await withDeadline(() => once(child, "close"), {
    timeoutMs: 3_000,
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), { connections: [] });
});

test("disable shares the dispatch lease and waits for an already-issued mutation to settle", async (t) => {
  const f = await dispatchFixture(t);
  f.stage();
  let issued;
  const entered = new Promise((resolve) => {
    issued = resolve;
  });
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const running = dispatchPrompt(
    { hook_event_name: "UserPromptSubmit", session_id: "owner" },
    {
      ...f.dispatchOptions,
      deliver: async (input) => {
        issued();
        await gate;
        return f.dispatchOptions.deliver(input);
      },
    },
  );
  await entered;
  let stopped = false;
  const disabling = disableSetup(
    { connection_id: f.connection.connectionId },
    f.options,
  ).then(() => {
    stopped = true;
  });
  assert.equal(stopped, false);
  assert.deepEqual(activeDestinations({ path: f.options.registryPath }), []);
  finish();
  await running;
  await disabling;
  assert.equal(stopped, true);
});

const identity = {
  principal_type: "user",
  authentication_method: "oauth",
  user_id: randomUUID(),
  project_id: randomUUID(),
  username: "bob",
  project_alias: "demo",
};
const wire = {
  installation_id: randomUUID(),
  user_id: identity.user_id,
  project_id: identity.project_id,
  username: "bob",
  project_alias: "demo",
  enabled: true,
  expires_at: "2099-01-01T00:00:00.000Z",
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "synapse-plugin-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registryPath = join(directory, "host.sqlite");
  const secrets = new Map();
  const options = {
    registryPath,
    hookHealth: () => ({ status: "verified" }),
    env: {},
    serverUrl: "https://synapse.example",
    resolveRoot: async () => join(directory, "project"),
    secretStore: {
      async set(account, value) {
        secrets.set(account, value);
      },
      async get(account) {
        if (!secrets.has(account)) throw new Error("Credential unavailable");
        return secrets.get(account);
      },
      async delete(account) {
        secrets.delete(account);
      },
    },
    createClient: () => ({
      async completePairing() {
        return { status: "connected", identity: wire };
      },
      async getIdentity() {
        return { identity: wire };
      },
      async disconnect() {
        return { disconnected: true };
      },
    }),
    openUrl: async () => {},
  };
  const prepare = () => prepareSetup({ identity }, options);
  const pairing = () => {
    const id = randomUUID();
    return {
      pairing_id: id,
      verification_url: `https://synapse.example/receiver/pairings/${id}`,
      expires_at: "2099-01-01T00:00:00.000Z",
      identity: { ...identity },
    };
  };
  return { directory, options, prepare, pairing, secrets };
}

test("first-use offer is once, deferral persists, manual setup remains available", async (t) => {
  const f = await fixture(t);
  const opts = { path: f.options.registryPath };
  assert.equal(offerSetupOnce(opts), true);
  assert.equal(offerSetupOnce(opts), false);
  deferSetup(opts);
  assert.equal(offerSetupOnce(opts), false);
  assert.equal((await f.prepare()).status, "approval_required");
  assert.equal(setupConnections(opts).length, 1);
});

test("enrollment is not ready until this installed build's real prompt hook is observed", async (t) => {
  const f = await fixture(t);
  f.options.hookHealth = promptHookHealth;
  f.options.env.CODEX_THREAD_ID = "setup-owner";
  const prepared = await f.prepare();
  const result = await completeSetup(
    { connection_id: prepared.connection_id, pairing: f.pairing() },
    f.options,
  );
  assert.equal(result.status, "hooks_pending");
  assert.equal(result.enrollment_status, "connected");
  assert.equal(activeDestinations({ path: f.options.registryPath }).length, 1);
  assert.equal((await f.prepare()).status, "hooks_pending");
  const healthOptions = { path: f.options.registryPath };
  recordPromptHook(
    { hook_event_name: "UserPromptSubmit", session_id: "another-chat" },
    healthOptions,
  );
  assert.equal((await f.prepare()).status, "hooks_pending");
  savePromptReceipt(
    {
      sessionId: "setup-owner",
      pluginRoot: "/old-install",
      version: "old-build",
    },
    healthOptions,
  );
  assert.equal((await f.prepare()).hooks.status, "different_build");
  recordPromptHook(
    { hook_event_name: "SessionStart", session_id: "setup-owner" },
    healthOptions,
  );
  assert.equal((await f.prepare()).status, "hooks_pending");
  recordPromptHook(
    { hook_event_name: "UserPromptSubmit", session_id: "setup-owner" },
    healthOptions,
  );
  assert.equal((await f.prepare()).status, "ready");
  assert.equal(
    (await setupStatus({ connection_id: prepared.connection_id }, f.options))
      .status,
    "ready",
  );
  assert.equal(
    promptHookHealth("setup-owner", {
      ...healthOptions,
      now: () => Date.now() + 31 * 60_000,
    }).status,
    "stale",
  );
  assert.equal(
    promptHookHealth(undefined, healthOptions).status,
    "not_observed",
  );
  assert.equal(f.secrets.size, 1);
});

test("installed prompt hook supplies readiness without source checkout or system Node; setup does not forge it", async (t) => {
  const f = await fixture(t);
  const bundle = join(f.directory, "installed plugin");
  await cp(resolve("plugins/synapse"), bundle, { recursive: true });
  const isolatedHealth = await import(
    pathToFileURL(join(bundle, "lib/hook-health.mjs"))
  );
  const options = { path: f.options.registryPath };
  assert.equal(
    isolatedHealth.promptHookHealth("owner", options).status,
    "not_observed",
  );
  const env = {
    PATH: "/usr/bin:/bin",
    CODEX_MCP_NODE_PATH: process.execPath,
    CODEX_APP_TOOLS_PIPE_PATH: join(f.directory, "unused.sock"),
    SYNAPSE_HOST_DB: f.options.registryPath,
    SYNAPSE_INBOX_PATH: join(f.directory, "inbox.sqlite"),
  };
  execFileSync(
    "/bin/sh",
    [join(bundle, "scripts/run-node.sh"), join(bundle, "scripts/setup.mjs")],
    { cwd: f.directory, env, input: '{"action":"inspect"}\n' },
  );
  assert.equal(
    isolatedHealth.promptHookHealth("owner", options).status,
    "not_observed",
  );
  execFileSync("/bin/sh", [join(bundle, "hooks/run-dispatch.sh")], {
    cwd: f.directory,
    env,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "owner",
      cwd: f.directory,
      prompt: "hello",
    }),
  });
  assert.equal(
    isolatedHealth.promptHookHealth("owner", options).status,
    "verified",
  );
  assert.equal(promptHookHealth("owner", options).status, "different_build");
});

test("plugin setup exposes only the hash, completes, reuses live enrollment and preserves state on reinstall", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  assert.match(prepared.credential_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(prepared),
    /syn_recv_|installation|project_root/,
  );
  const key = [...f.secrets.values()][0];
  assert.equal(
    (await readFile(f.options.registryPath)).includes(Buffer.from(key)),
    false,
  );
  const progress = [];
  const ready = await completeSetup(
    { connection_id: prepared.connection_id, pairing: f.pairing() },
    { ...f.options, onProgress: (s) => progress.push(s) },
  );
  assert.equal(ready.status, "ready");
  assert.equal(progress.length, 1);
  assert.equal(
    activeDestinations({ path: f.options.registryPath })[0].projectRoot,
    ready.project,
  );
  assert.equal((await f.prepare()).connection_id, prepared.connection_id);
  assert.equal(f.secrets.size, 1);
  const bundle = join(f.directory, "installed plugin");
  await cp(resolve("plugins/synapse"), bundle, { recursive: true });
  const output = execFileSync(
    "/bin/sh",
    [join(bundle, "scripts/run-node.sh"), join(bundle, "scripts/setup.mjs")],
    {
      input: JSON.stringify({ action: "inspect" }),
      cwd: f.directory,
      env: {
        PATH: "/no-system-node-or-npm",
        CODEX_MCP_NODE_PATH: process.execPath,
        SYNAPSE_HOST_DB: f.options.registryPath,
      },
      encoding: "utf8",
    },
  );
  assert.equal(
    JSON.parse(output).connections[0].connection_id,
    prepared.connection_id,
  );
  assert.throws(
    () =>
      activateDestination(
        {
          ...getReceiverConnectionById(prepared.connection_id, {
            path: f.options.registryPath,
          }),
          connectionId: "another",
        },
        { path: f.options.registryPath },
      ),
    /disconnected/,
  );
});

test("runtime launcher fails clearly without Codex runtime and never tries system Node", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      execFileSync(
        "/bin/sh",
        [
          resolve("plugins/synapse/scripts/run-node.sh"),
          resolve("plugins/synapse/scripts/setup.mjs"),
        ],
        { cwd: f.directory, env: { PATH: "/no-node" }, stdio: "pipe" },
      ),
    /runtime supplied by Codex/,
  );
  assert.equal(new URL(await configuredReceiverServer()).protocol, "https:");
});

test("account IDs, not duplicate aliases, and exact consent origin/path are enforced before opening", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const connection = getReceiverConnectionById(prepared.connection_id, {
    path: f.options.registryPath,
  });
  assert.throws(
    () => setupIdentity({ ...identity, authentication_method: "api_key" }),
    /OAuth/,
  );
  for (const change of [
    (p) => ({ ...p, identity: { ...p.identity, user_id: randomUUID() } }),
    (p) => ({ ...p, identity: { ...p.identity, project_id: randomUUID() } }),
    (p) => ({
      ...p,
      verification_url: p.verification_url.replace(
        "synapse.example",
        "evil.example",
      ),
    }),
    (p) => ({ ...p, verification_url: `${p.verification_url}?redirect=evil` }),
    (p) => ({ ...p, verification_url: `${p.verification_url}/elsewhere` }),
    (p) => ({ ...p, expires_at: "2000-01-01T00:00:00Z" }),
  ])
    assert.throws(
      () => validateSetupPairing(change(f.pairing()), connection),
      /Pairing|approval URL/,
    );
  await assert.rejects(
    () =>
      prepareSetup(
        { identity: { ...identity, user_id: randomUUID() } },
        f.options,
      ),
    /another Synapse account/,
  );
  let opened = false;
  await assert.rejects(
    () =>
      completeSetup(
        {
          connection_id: prepared.connection_id,
          pairing: {
            ...f.pairing(),
            verification_url: "https://evil.example/",
          },
        },
        {
          ...f.options,
          openUrl: () => {
            opened = true;
          },
        },
      ),
    /approval URL/,
  );
  assert.equal(opened, false);
});

test("revocation, expiry and wrong live identity require reconnect instead of ready", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  await completeSetup(
    { connection_id: prepared.connection_id, pairing: f.pairing() },
    f.options,
  );
  for (const current of [
    { ...wire, enabled: false },
    { ...wire, expires_at: "2000-01-01T00:00:00Z" },
    { ...wire, project_id: randomUUID() },
  ]) {
    const bad = {
      ...f.options,
      createClient: () => ({
        async getIdentity() {
          return { identity: current };
        },
      }),
    };
    assert.equal(
      (await setupStatus({ connection_id: prepared.connection_id }, bad))
        .status,
      "reconnect_required",
    );
    assert.equal(
      (await prepareSetup({ identity }, bad)).status,
      "reconnect_required",
    );
  }
  assert.equal(
    (await disableSetup({ connection_id: prepared.connection_id }, f.options))
      .status,
    "disabled",
  );
  assert.equal(activeDestinations({ path: f.options.registryPath }).length, 0);
  assert.equal(f.secrets.size, 0);
  assert.equal((await f.prepare()).status, "approval_required");
});

test("approval deadline covers stalled operations, cancels work and retains resumable state", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  let signal;
  const stalled = {
    ...f.options,
    timeoutMs: 30,
    createClient: (options) => {
      signal = options.signal;
      return {
        completePairing: () =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      };
    },
  };
  const start = Date.now();
  await assert.rejects(
    () =>
      completeSetup(
        { connection_id: prepared.connection_id, pairing: f.pairing() },
        stalled,
      ),
    /pending/,
  );
  assert.ok(Date.now() - start < 1_000);
  assert.equal(signal.aborted, true);
  assert.equal((await f.prepare()).connection_id, prepared.connection_id);
  assert.equal(
    (
      await completeSetup(
        { connection_id: prepared.connection_id, pairing: f.pairing() },
        f.options,
      )
    ).status,
    "ready",
  );
});

test("disable during browser approval prevents late completion from restoring receiving", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  let disabling;
  await assert.rejects(
    () =>
      completeSetup(
        { connection_id: prepared.connection_id, pairing: f.pairing() },
        {
          ...f.options,
          openUrl: async () => {
            disabling = disableSetup(
              { connection_id: prepared.connection_id },
              f.options,
            );
          },
        },
      ),
    /Credential|cancelled/,
  );
  await disabling;
  assert.deepEqual(activeDestinations({ path: f.options.registryPath }), []);
});

test("one setup lease fences overlapping prompts and releases on failure", async (t) => {
  const f = await fixture(t);
  const options = { path: f.options.registryPath };
  await withReceiverLease(
    "fixture",
    async () => {
      assert.deepEqual(
        await withReceiverLease(
          "fixture",
          () => assert.fail("overlap"),
          options,
        ),
        { busy: true },
      );
    },
    options,
  );
  assert.equal(await withReceiverLease("fixture", () => true, options), true);
  await assert.rejects(
    () => withDeadline(() => new Promise(() => {}), { timeoutMs: 10 }),
    /timed out/i,
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    () =>
      withDeadline(() => assert.fail("already aborted"), {
        signal: controller.signal,
      }),
    /cancelled/,
  );
});

test("worktree setup resolves to its primary saved project", async (t) => {
  const f = await fixture(t);
  const primary = join(f.directory, "git");
  const child = join(f.directory, "child");
  execFileSync("git", ["init", "-b", "main", primary]);
  execFileSync("git", [
    "-C",
    primary,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  execFileSync("git", [
    "-C",
    primary,
    "worktree",
    "add",
    "--detach",
    child,
    "HEAD",
  ]);
  assert.equal(await primaryProject(primary), await primaryProject(child));
  await assert.rejects(() => primaryProject(f.directory), /Command failed/);
  const catalog = [
    "list_projects",
    "create_thread",
    "send_message_to_thread",
    "read_thread",
  ].map((name) => ({ name }));
  let closes = 0;
  const createClient = () => ({
    async listTools() {
      return catalog;
    },
    async callTool(name) {
      assert.equal(name, "list_projects");
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              projects: [
                { path: primary, hostId: "local", isGitRepository: true },
              ],
            }),
          },
        ],
      };
    },
    async close() {
      closes += 1;
    },
  });
  assert.equal(
    await savedProject(child, { sessionId: "owner", createClient }),
    await primaryProject(primary),
  );
  catalog.pop();
  await assert.rejects(
    () => savedProject(child, { sessionId: "owner", createClient }),
    /lacks the native task tools/,
  );
  assert.equal(closes, 2);
});

async function dispatchFixture(t) {
  const f = await fixture(t);
  const prepared = await f.prepare();
  await completeSetup(
    { connection_id: prepared.connection_id, pairing: f.pairing() },
    f.options,
  );
  const connection = getReceiverConnectionById(prepared.connection_id, {
    path: f.options.registryPath,
  });
  const inboxOptions = { path: join(f.directory, "inbox.sqlite") };
  const stage = (
    sequence = 1,
    conversationId = "55555555-5555-4555-8555-555555555555",
  ) => {
    const message = {
      messageId: randomUUID(),
      conversationId,
      sequence,
      senderUserId: randomUUID(),
      senderUsername: "alice",
      recipientUserId: identity.user_id,
      recipientProjectId: identity.project_id,
      message: "private incoming message",
      contentHash: messageContentHash("private incoming message"),
      claimToken: "test-claim",
      leaseExpiresAt: wire.expires_at,
    };
    stageCloudMessage(
      {
        message,
        identity: connection.identity,
        projectRoot: connection.projectRoot,
        channelId: cloudChannelId(
          wire.installation_id,
          identity.user_id,
          conversationId,
        ),
      },
      inboxOptions,
    );
    confirmCloudImport(
      { messageId: message.messageId, installationId: wire.installation_id },
      inboxOptions,
    );
    return message.messageId;
  };
  const calls = [];
  const dispatchOptions = {
    env: { CODEX_APP_TOOLS_PIPE_PATH: "fixture-pipe" },
    registryPath: f.options.registryPath,
    inboxOptions,
    sync: async ({ projectRoot }) => {
      assert.equal(projectRoot, connection.projectRoot);
      return { authorized: true, identity: connection.identity };
    },
    deliver: async (input) => {
      const delivery = getReservedDelivery(input, inboxOptions);
      calls.push(delivery);
      acknowledgeMessage(
        {
          jobId: delivery.jobId,
          deliveryId: delivery.deliveryId,
          threadId: "native-task",
          hostId: "local",
          projectId: "saved-project",
        },
        inboxOptions,
      );
    },
  };
  return { ...f, connection, stage, dispatchOptions, calls, inboxOptions };
}

test("any local chat wakes the same saved destination; each prompt makes at most one delivery", async (t) => {
  const f = await dispatchFixture(t);
  for (const cwd of [
    f.directory,
    "/unrelated-project",
    "/linked-worktree",
    undefined,
  ]) {
    const job = f.stage(f.calls.length + 1);
    const result = await dispatchPrompt(
      { hook_event_name: "UserPromptSubmit", session_id: "owner", cwd },
      f.dispatchOptions,
    );
    assert.deepEqual(result, { attempted: true });
    assert.equal(getJob(job, f.inboxOptions).status, "completed");
    assert.equal(f.calls.at(-1).projectRoot, f.connection.projectRoot);
    assert.doesNotMatch(JSON.stringify(result), /private incoming/);
  }
  f.stage(10);
  f.stage(11);
  const previous = f.calls.length;
  await dispatchPrompt(
    { hook_event_name: "UserPromptSubmit", session_id: "owner" },
    f.dispatchOptions,
  );
  assert.equal(f.calls.length, previous + 1);
});

test("concurrent prompts share a receiver lock and delivery prompts never trigger a chain", async (t) => {
  const f = await dispatchFixture(t);
  f.stage();
  const input = { hook_event_name: "UserPromptSubmit", session_id: "owner" };
  await Promise.all(
    Array.from({ length: 5 }, () => dispatchPrompt(input, f.dispatchOptions)),
  );
  assert.equal(f.calls.length, 1);
  const delivery = f.calls[0];
  assert.equal(isDeliveryPrompt(delivery.nativePrompt, f.inboxOptions), true);
  f.stage(2);
  await dispatchPrompt(
    { ...input, prompt: delivery.nativePrompt },
    f.dispatchOptions,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    isDeliveryPrompt(
      `Anything\n\n<!-- ${formatDeliveryMarker("unknown", "unknown")} -->`,
      f.inboxOptions,
    ),
    false,
  );
  await dispatchPrompt(input, f.dispatchOptions);
  assert.equal(f.calls.length, 2);
});

test("post-delivery reconciliation failure consumes the prompt and preserves cancellation", async (t) => {
  const f = await dispatchFixture(t);
  const root = f.connection.projectRoot;
  execFileSync("git", ["init", "-b", "main", root]);
  const local = queueMessage(
    { channelId: "legacy-fallback", projectRoot: root, task: "local task" },
    f.inboxOptions,
  );
  f.stage();
  let reconciliations = 0;
  const input = {
    hook_event_name: "UserPromptSubmit",
    session_id: "owner",
    cwd: root,
  };
  assert.deepEqual(
    await dispatchPrompt(input, {
      ...f.dispatchOptions,
      reconcile: async () => {
        if (++reconciliations === 2) throw new Error("binding database busy");
      },
    }),
    { attempted: true },
  );
  assert.equal(f.calls.length, 1);
  assert.equal(getJob(local.jobId, f.inboxOptions).status, "pending");

  f.stage(2);
  const controller = new AbortController();
  const reason = new Error("cancel reconciliation");
  reconciliations = 0;
  await assert.rejects(
    () =>
      dispatchPrompt(input, {
        ...f.dispatchOptions,
        signal: controller.signal,
        reconcile: async () => {
          if (++reconciliations === 2) {
            controller.abort(reason);
            throw reason;
          }
        },
      }),
    (error) => error === reason,
  );
  assert.equal(f.calls.length, 2);
  assert.equal(getJob(local.jobId, f.inboxOptions).status, "pending");
});

test("setup state reads and writes wait for a concurrent SQLite writer", async (t) => {
  const f = await dispatchFixture(t);
  const options = { path: f.options.registryPath };
  savePromptReceipt(
    { sessionId: "busy-owner", pluginRoot: "/fixture", version: "test" },
    options,
  );
  const checks = [
    () =>
      assert.equal(readPromptReceipt("busy-owner", options).version, "test"),
    () => assert.equal(activeDestinations(options).length, 1),
    () => assert.equal(setupConnections(options).length, 1),
    () =>
      savePromptReceipt(
        { sessionId: "next-owner", pluginRoot: "/fixture", version: "test" },
        options,
      ),
  ];
  for (const check of checks) {
    const worker = new Worker(
      `
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const db = new DatabaseSync(workerData);
      db.exec("BEGIN EXCLUSIVE");
      parentPort.postMessage("locked");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 350);
    `,
      { eval: true, workerData: options.path },
    );
    t.after(() => worker.terminate());
    const exited = once(worker, "exit");
    await once(worker, "message");
    try {
      check();
    } finally {
      await exited;
    }
  }
});

test("authorization fence failures after issuing a mutation stay uncertain for new and existing tasks", async (t) => {
  for (const existingTask of [false, true]) {
    const f = await dispatchFixture(t);
    if (existingTask) {
      f.stage();
      await dispatchPrompt(
        { hook_event_name: "UserPromptSubmit", session_id: "owner" },
        f.dispatchOptions,
      );
    }
    const jobId = f.stage(existingTask ? 2 : 1);
    await dispatchPrompt(
      { hook_event_name: "UserPromptSubmit", session_id: "owner" },
      {
        ...f.dispatchOptions,
        deliver: (input) =>
          runReservedDelivery(input, {
            load: (value) => getReservedDelivery(value, f.inboxOptions),
            retry: () => assert.fail("issued mutations must never be retried"),
            uncertain: (value) => {
              assert.match(value.error, /must be synchronous/);
              return markNativeMutationUncertain(value, f.inboxOptions);
            },
            route: (delivery, metadata) =>
              routeDelivery(delivery, {
                ...metadata,
                authorizeCloud: async () => {},
                cloudAuthorizationOptions: {
                  registryPath: f.options.registryPath,
                },
                markIssued: (value) => {
                  markNativeMutationIssued(value, f.inboxOptions);
                  // Rejected by the synchronous fence after the inbox commit succeeds.
                  return Promise.resolve(true);
                },
                createClient: () => ({
                  start: async () => {},
                  close: async () => {},
                  callTool: async (name) => {
                    assert.equal(
                      name,
                      "list_projects",
                      "fence failure prevents native calls",
                    );
                    return {
                      success: true,
                      contentItems: [
                        {
                          type: "inputText",
                          text: JSON.stringify({
                            projects: [
                              {
                                projectId: "saved-project",
                                path: f.connection.projectRoot,
                                isGitRepository: true,
                              },
                            ],
                          }),
                        },
                      ],
                    };
                  },
                }),
              }),
          }),
      },
    );
    assert.equal(getJob(jobId, f.inboxOptions).status, "uncertain");
    assert.equal(
      getJob(jobId, f.inboxOptions).nativeMutationState,
      "uncertain",
    );
    await dispatchPrompt(
      { hook_event_name: "UserPromptSubmit", session_id: "owner" },
      f.dispatchOptions,
    );
    assert.equal(f.calls.length, existingTask ? 1 : 0);
  }
});

test("prompt dispatch repairs a missed startup binding and flushes receipts without creating a second task", async (t) => {
  const f = await dispatchFixture(t);
  const jobId = f.stage();
  const threadId = randomUUID();
  let nativeCreates = 0;
  let receipts = 0;
  let allowResolution = false;
  let result;
  const options = {
    ...f.dispatchOptions,
    sync: async (input) => {
      if (input.receiptsOnly) {
        receipts += 1;
        return { flushed: 1 };
      }
      return { authorized: true, identity: f.connection.identity };
    },
    deliver: async (input) => {
      nativeCreates += 1;
      const delivery = getReservedDelivery(input, f.inboxOptions);
      markNativeMutationIssued(
        { ...input, receiverIdentity: f.connection.identity },
        f.inboxOptions,
      );
      acceptProvisioning(
        {
          ...input,
          clientThreadId: "client-new-thread:fixture",
          projectId: "saved-project",
          hostId: "local",
        },
        f.inboxOptions,
      );
      result = {
        thread: {
          id: threadId,
          kind: "codex",
          hostId: "local",
          cwd: "/selected-project-worktree",
        },
        turns: [
          {
            items: [
              {
                type: "functionCallOutput",
                namespace: "codex_app",
                name: "create_thread",
                output: {
                  text: `<codex_delegation><source_thread_id>owner</source_thread_id><input>${delivery.nativePrompt.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</input></codex_delegation>`,
                },
              },
            ],
          },
        ],
      };
    },
    reconciliationOptions: {
      resolveId: async () => (allowResolution ? threadId : null),
      verifyWorktree: async () => true,
      createClient: () => ({
        async callTool(name) {
          assert.equal(name, "read_thread");
          return {
            success: true,
            contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
          };
        },
        async close() {},
      }),
    },
  };
  // First response has no permanent ID and the child startup hook never runs.
  await dispatchPrompt(
    { hook_event_name: "UserPromptSubmit", session_id: "owner" },
    options,
  );
  assert.equal(getJob(jobId, f.inboxOptions).status, "accepted");
  allowResolution = true;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      dispatchPrompt(
        { hook_event_name: "UserPromptSubmit", session_id: "different-owner" },
        options,
      ),
    ),
  );
  assert.equal(nativeCreates, 1);
  assert.equal(getJob(jobId, f.inboxOptions).threadId, threadId);
  assert.equal(getJob(jobId, f.inboxOptions).status, "completed");
  assert.ok(receipts >= 2);
});

test("cloud wake never consumes another project's legacy local queue or retries uncertain native work", async (t) => {
  const f = await dispatchFixture(t);
  const local = queueMessage(
    {
      channelId: "local-channel",
      projectRoot: f.connection.projectRoot,
      task: "legacy",
    },
    f.inboxOptions,
  );
  await dispatchPrompt(
    { hook_event_name: "UserPromptSubmit", session_id: "owner" },
    f.dispatchOptions,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(getJob(local.jobId, f.inboxOptions).status, "pending");
  const jobId = f.stage();
  await dispatchPrompt(
    { hook_event_name: "UserPromptSubmit", session_id: "owner" },
    {
      ...f.dispatchOptions,
      deliver: async (input) => {
        markNativeMutationIssued(input, f.inboxOptions);
        markNativeMutationUncertain(
          { ...input, error: "lost response" },
          f.inboxOptions,
        );
        throw new Error("lost response");
      },
    },
  );
  assert.equal(getJob(jobId, f.inboxOptions).status, "uncertain");
  await dispatchPrompt(
    { hook_event_name: "UserPromptSubmit", session_id: "new-owner" },
    f.dispatchOptions,
  );
  assert.equal(f.calls.length, 0);
});

test("local stop after live authorization but before issue prevents native mutation", async (t) => {
  const f = await dispatchFixture(t);
  const jobId = f.stage();
  await dispatchPrompt(
    { hook_event_name: "UserPromptSubmit", session_id: "owner" },
    {
      ...f.dispatchOptions,
      deliver: async (input) => {
        const delivery = getReservedDelivery(input, f.inboxOptions);
        await assert.rejects(
          () =>
            routeDelivery(delivery, {
              ownerThreadId: "owner",
              cloudAuthorizationOptions: {
                registryPath: f.options.registryPath,
              },
              authorizeCloud: async () => {
                markReceiverDisconnecting(f.connection.connectionId, {
                  path: f.options.registryPath,
                });
              },
              markIssued: (value) =>
                markNativeMutationIssued(value, f.inboxOptions),
              createClient: () => ({
                start: async () => {},
                close: async () => {},
                callTool: async (name) => {
                  assert.equal(
                    name,
                    "list_projects",
                    "Native mutation must not run after local stop",
                  );
                  return {
                    success: true,
                    contentItems: [
                      {
                        type: "inputText",
                        text: JSON.stringify({
                          projects: [
                            {
                              projectId: "saved",
                              path: f.connection.projectRoot,
                              isGitRepository: true,
                            },
                          ],
                        }),
                      },
                    ],
                  };
                },
              }),
            }),
          /authorization is no longer current/,
        );
      },
    },
  );
  assert.equal(getJob(jobId, f.inboxOptions).nativeMutationState, "intent");
});

test("concurrent fresh registry opens serialize additive schema migration", async (t) => {
  const f = await fixture(t);
  const modulePath = pathToFileURL(
    resolve("plugins/synapse/lib/receiver-registry.mjs"),
  ).href;
  await Promise.all(
    Array.from({ length: 24 }, async () => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'const {getReceiverConnection}=await import(process.argv[1]);getReceiverConnection("/fixture",{path:process.argv[2]});',
          modulePath,
          f.options.registryPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const [code] = await once(child, "close");
      assert.equal(code, 0, stderr);
    }),
  );
});

test("legacy enrollment without a selected destination is not falsely reported ready", async (t) => {
  const f = await dispatchFixture(t);
  deactivateDestination(f.connection.connectionId, {
    path: f.options.registryPath,
  });
  assert.equal(
    (await setupStatus({ connection_id: f.connection.connectionId }, f.options))
      .status,
    "setup_required",
  );
  assert.equal((await f.prepare()).status, "ready");
});
