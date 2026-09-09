import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptProvisioning,
  confirmCloudImport,
  getJob,
  markNativeMutationIssued,
  markNativeMutationUncertain,
  queueMessage,
  reserveNextMessage,
  stageCloudMessage,
} from "../../plugins/synapse/lib/inbox.mjs";
import { formatDeliveryMarker } from "../../plugins/synapse/lib/markers.mjs";
import { delegationFromOutput } from "../../plugins/synapse/lib/native-evidence.mjs";
import {
  reconcileNativeBindings,
  resolveClientThreadId,
} from "../../plugins/synapse/lib/native-reconcile.mjs";
import {
  cloudChannelId,
  messageContentHash,
} from "../../plugins/synapse/lib/receiver-contract.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "synapse-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  const child = join(directory, "child");
  const codex = join(directory, "codex");
  await mkdir(codex);
  execFileSync("git", ["init", "-b", "main", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  execFileSync(
    "git",
    ["-C", root, "worktree", "add", "--detach", child, "HEAD"],
    { stdio: "ignore" },
  );
  const inboxOptions = { path: join(directory, "inbox.sqlite") };
  const identity = {
    installationId: randomUUID(),
    userId: randomUUID(),
    projectId: randomUUID(),
    username: "bob",
    projectAlias: "demo",
    enabled: true,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const jobId = randomUUID();
  const conversationId = randomUUID();
  stageCloudMessage(
    {
      projectRoot: root,
      identity,
      channelId: cloudChannelId(
        identity.installationId,
        identity.userId,
        conversationId,
      ),
      message: {
        messageId: jobId,
        conversationId,
        sequence: 1,
        senderUserId: randomUUID(),
        senderUsername: "alice",
        recipientUserId: identity.userId,
        recipientProjectId: identity.projectId,
        message: "private task",
        contentHash: messageContentHash("private task"),
        claimToken: "claim",
        leaseExpiresAt: identity.expiresAt,
      },
    },
    inboxOptions,
  );
  confirmCloudImport(
    { messageId: jobId, installationId: identity.installationId },
    inboxOptions,
  );
  const reserved = reserveNextMessage(
    { projectRoot: root, ownerSessionId: "original-owner", source: "cloud" },
    { ...inboxOptions, receiverIdentity: identity },
  );
  markNativeMutationIssued(
    { jobId, deliveryId: reserved.deliveryId, receiverIdentity: identity },
    inboxOptions,
  );
  const temporary = `client-new-thread:${randomUUID()}`;
  acceptProvisioning(
    {
      jobId,
      deliveryId: reserved.deliveryId,
      clientThreadId: temporary,
      projectId: "saved-project",
      hostId: "local",
    },
    inboxOptions,
  );
  const threadId = randomUUID();
  const statePath = join(codex, ".codex-global-state.json");
  const alias = {
    [`thread-client-id-v1:${encodeURIComponent(`local:${threadId}`)}`]:
      temporary,
  };
  const writeAliases = (entries = alias) =>
    writeFile(
      statePath,
      JSON.stringify({ "electron-persisted-atom-state": entries }),
    );
  await writeAliases();
  const result = {
    thread: { id: threadId, kind: "codex", hostId: "local", cwd: child },
    turns: [
      {
        items: [
          {
            type: "functionCallOutput",
            namespace: "codex_app",
            name: "create_thread",
            output: {
              text: `<codex_delegation>\n<source_thread_id>original-owner</source_thread_id>\n<input>private task\n\n&lt;!-- ${formatDeliveryMarker(jobId, reserved.deliveryId)} --&gt;</input>\n</codex_delegation>`,
              truncated: false,
            },
          },
        ],
      },
    ],
  };
  let reads = 0;
  let closes = 0;
  const options = {
    env: { CODEX_HOME: codex },
    inboxOptions,
    createClient: () => ({
      async callTool(name, args, context) {
        assert.equal(
          name,
          "read_thread",
          "reconciliation must never create or send a task",
        );
        assert.equal(args.threadId, threadId);
        assert.equal(args.maxOutputCharsPerItem, 20000);
        assert.equal(context.threadId, "current-owner");
        reads += 1;
        return {
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
        };
      },
      async close() {
        closes += 1;
      },
    }),
  };
  const input = {
    projectRoot: root,
    installationId: identity.installationId,
    ownerThreadId: "current-owner",
  };
  return {
    directory,
    root,
    child,
    options,
    input,
    result,
    statePath,
    writeAliases,
    alias,
    jobId,
    reserved,
    threadId,
    temporary,
    get reads() {
      return reads;
    },
    get closes() {
      return closes;
    },
  };
}

test("a missed child hook is reconciled from native evidence after restart, exactly once", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await reconcileNativeBindings(f.input, f.options), {
    reconciled: 1,
    pending: 0,
  });
  assert.equal(getJob(f.jobId, f.options.inboxOptions).threadId, f.threadId);
  assert.equal(getJob(f.jobId, f.options.inboxOptions).status, "completed");
  assert.deepEqual(await reconcileNativeBindings(f.input, f.options), {
    reconciled: 0,
    pending: 0,
  });
  assert.equal(f.reads, 1);
  assert.equal(f.closes, 1);
});

test("native evidence tolerates leading whitespace but not arbitrary preambles", async (t) => {
  const f = await fixture(t);
  const output = f.result.turns[0].items[0].output;
  const original = output.text;
  output.text = ` \t\r\n${original}`;
  assert.deepEqual(await reconcileNativeBindings(f.input, f.options), {
    reconciled: 1,
    pending: 0,
  });
  assert.equal(delegationFromOutput(`Untrusted preamble\n${original}`), null);
  for (const value of [null, 42, {}, { text: false }])
    assert.equal(delegationFromOutput(value), null);
});

test("a null native response can be retried within the same bounded reconciliation", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const createClient = f.options.createClient;
  assert.deepEqual(
    await reconcileNativeBindings(f.input, {
      ...f.options,
      waitMs: 1500,
      createClient: () => {
        const client = createClient();
        const call = client.callTool.bind(client);
        client.callTool = (...args) =>
          ++attempts === 1
            ? {
                success: true,
                contentItems: [{ type: "inputText", text: "null" }],
              }
            : call(...args);
        return client;
      },
    }),
    { reconciled: 1, pending: 0 },
  );
  assert.equal(attempts, 2);
});

test("cloud receipt reconciliation excludes accepted legacy local tasks", async (t) => {
  const f = await fixture(t);
  const local = queueMessage(
    { channelId: "legacy-local", projectRoot: f.root, task: "local task" },
    f.options.inboxOptions,
  );
  const reserved = reserveNextMessage(
    { projectRoot: f.root, ownerSessionId: "local-owner", source: "local" },
    f.options.inboxOptions,
  );
  acceptProvisioning(
    {
      jobId: local.jobId,
      deliveryId: reserved.deliveryId,
      clientThreadId: "client-new-thread:local",
      projectId: "saved-project",
      hostId: "local",
    },
    f.options.inboxOptions,
  );
  assert.deepEqual(await reconcileNativeBindings(f.input, f.options), {
    reconciled: 1,
    pending: 0,
  });
  assert.equal(getJob(local.jobId, f.options.inboxOptions).status, "accepted");
  assert.equal(f.reads, 1);
  assert.equal(
    delegationFromOutput({
      text: "<codex_delegation>truncated local data",
      truncated: true,
    }),
    null,
  );
});

test("missing, corrupt, changed and duplicate alias formats keep accepted jobs fenced", async (t) => {
  const f = await fixture(t);
  for (const entries of [
    {},
    { "thread-client-id-v2:local": f.temporary },
    {
      ...f.alias,
      [`thread-client-id-v1:${encodeURIComponent(`local:${randomUUID()}`)}`]:
        f.temporary,
    },
  ]) {
    await f.writeAliases(entries);
    assert.deepEqual(await reconcileNativeBindings(f.input, f.options), {
      reconciled: 0,
      pending: 1,
    });
  }
  await writeFile(f.statePath, "partial JSON");
  assert.equal(await resolveClientThreadId(f.temporary, f.options), null);
  await writeFile(f.statePath, "x".repeat(8 * 1024 * 1024 + 1));
  assert.equal(await resolveClientThreadId(f.temporary, f.options), null);
  await rm(f.statePath);
  assert.equal(await resolveClientThreadId(f.temporary, f.options), null);
  assert.equal(f.reads, 0);
  assert.equal(getJob(f.jobId, f.options.inboxOptions).status, "accepted");
});

test("large cloud tasks reconcile using the exact leading local receipt within native output limits", async (t) => {
  const f = await fixture(t);
  const output = f.result.turns[0].items[0].output;
  output.text =
    `<codex_delegation>\n<source_thread_id>original-owner</source_thread_id>\n<input>&lt;!-- ${formatDeliveryMarker(f.jobId, f.reserved.deliveryId)} --&gt;\n\n${"large task ".repeat(6000)}`.slice(
      0,
      20000,
    );
  output.truncated = true;
  assert.deepEqual(await reconcileNativeBindings(f.input, f.options), {
    reconciled: 1,
    pending: 0,
  });
  const spoof = await fixture(t);
  spoof.result.turns[0].items[0].output.text = output.text;
  spoof.result.turns[0].items[0].output.truncated = true;
  assert.deepEqual(await reconcileNativeBindings(spoof.input, spoof.options), {
    reconciled: 0,
    pending: 1,
  });
});

test("wrong task, source, marker, namespace, host, truncated output and repository cannot bind", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.result);
  const changes = [
    (r) => {
      r.thread.id = randomUUID();
    },
    (r) => {
      r.thread.hostId = "remote";
    },
    (r) => {
      r.thread.cwd = f.root;
    },
    (r) => {
      r.thread.cwd = f.directory;
    },
    (r) => {
      r.turns[0].items[0].namespace = "untrusted";
    },
    (r) => {
      r.turns[0].items[0].type = "agentMessage";
    },
    (r) => {
      r.turns[0].items[0].output.truncated = true;
    },
    (r) => {
      r.turns[0].items[0].output.text = r.turns[0].items[0].output.text.replace(
        "original-owner",
        "wrong-owner",
      );
    },
    (r) => {
      r.turns[0].items[0].output.text = r.turns[0].items[0].output.text.replace(
        f.reserved.deliveryId,
        randomUUID(),
      );
    },
    (r) => {
      r.turns[0].items[0].output.text = "<codex_delegation>missing evidence";
    },
  ];
  for (const change of changes) {
    Object.assign(f.result, structuredClone(original));
    change(f.result);
    assert.deepEqual(await reconcileNativeBindings(f.input, f.options), {
      reconciled: 0,
      pending: 1,
    });
    assert.equal(getJob(f.jobId, f.options.inboxOptions).status, "accepted");
  }
});

test("delayed task IDs are read within a bounded check; cancellation and errors do not replay", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  assert.deepEqual(
    await reconcileNativeBindings(f.input, {
      ...f.options,
      waitMs: 1000,
      resolveId: async () => (++attempts < 2 ? null : f.threadId),
    }),
    { reconciled: 1, pending: 0 },
  );
  const pending = await fixture(t);
  const started = Date.now();
  assert.deepEqual(
    await reconcileNativeBindings(pending.input, {
      ...pending.options,
      waitMs: 30,
      resolveId: async () => null,
    }),
    { reconciled: 0, pending: 1 },
  );
  assert.ok(Date.now() - started < 500);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    () =>
      reconcileNativeBindings(pending.input, {
        ...pending.options,
        signal: controller.signal,
      }),
    /cancelled/,
  );
  assert.deepEqual(
    await reconcileNativeBindings(pending.input, {
      ...pending.options,
      createClient: () => ({
        async callTool() {
          throw new Error("native API unavailable");
        },
        async close() {},
      }),
    }),
    { reconciled: 0, pending: 1 },
  );
  assert.equal(
    getJob(pending.jobId, pending.options.inboxOptions).status,
    "accepted",
  );
});

test("wrong receiver and uncertain native outcomes are excluded from reconciliation", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await reconcileNativeBindings(
      { ...f.input, installationId: randomUUID() },
      f.options,
    ),
    { reconciled: 0, pending: 0 },
  );
  markNativeMutationUncertain(
    { jobId: f.jobId, deliveryId: f.reserved.deliveryId, error: "uncertain" },
    f.options.inboxOptions,
  );
  assert.deepEqual(await reconcileNativeBindings(f.input, f.options), {
    reconciled: 0,
    pending: 0,
  });
  assert.equal(f.reads, 0);
});
