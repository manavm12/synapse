import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskProcessor } from "../../src/client/host.mjs";
import { HostStore } from "../../src/client/store.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeAppServer extends EventEmitter {
  constructor({ autoStartOnAdd = true } = {}) {
    super();
    this.calls = [];
    this.status = { type: "idle" };
    this.queue = [];
    this.turns = [];
    this.nextQueue = 1;
    this.nextTurn = 1;
    this.threadStarts = 0;
    this.autoStartOnAdd = autoStartOnAdd;
  }

  async start() {}
  async close() {}

  async request(method, params) {
    this.calls.push({ method, params });
    switch (method) {
      case "project/list":
        return { data: [], nextCursor: null };
      case "project/create":
        return {
          project: { id: "project-1", name: params.name, roots: params.roots },
        };
      case "project/read":
        return { project: { id: "project-1" } };
      case "permissionProfile/list":
        return {
          data: [
            { id: ":read-only", allowed: true },
            { id: ":workspace", allowed: true },
          ],
          nextCursor: null,
        };
      case "thread/start":
        this.threadStarts += 1;
        return { thread: { id: "thread-1", status: this.status, turns: [] } };
      case "thread/name/set":
      case "thread/resume":
        return {};
      case "thread/read":
        return {
          thread: {
            id: "thread-1",
            status: this.status,
            turns: params.includeTurns ? this.turns : [],
          },
        };
      case "thread/items/list":
        return {
          data: this.turns.flatMap((turn) =>
            turn.items.map((item) => ({ turnId: turn.id, item })),
          ),
          nextCursor: null,
        };
      case "thread/queue/add": {
        const queuedSubmission = {
          id: `queue-${this.nextQueue++}`,
          input: params.input,
          clientUserMessageId: params.clientUserMessageId,
        };
        this.queue.push(queuedSubmission);
        if (this.autoStartOnAdd && this.status.type === "idle") {
          const turn = this.startSubmission(queuedSubmission.id);
          this.emit("item/started", {
            threadId: "thread-1",
            turnId: turn.id,
            item: turn.items[0],
          });
        }
        return { queuedSubmission };
      }
      case "thread/queue/list":
        return { data: [...this.queue], nextCursor: null };
      case "thread/queue/start": {
        if (this.status.type !== "idle") {
          throw new Error("thread is active");
        }
        const turn = this.startSubmission(params.queuedSubmissionId);
        this.emit("turn/started", { threadId: "thread-1", turn });
        return { turn };
      }
      default:
        throw new Error(`Unexpected App Server request: ${method}`);
    }
  }

  startSubmission(queuedSubmissionId) {
    const index = this.queue.findIndex(
      (submission) => submission.id === queuedSubmissionId,
    );
    const [submission] = this.queue.splice(index, 1);
    const turn = {
      id: `turn-${this.nextTurn++}`,
      status: "inProgress",
      items: [
        {
          type: "userMessage",
          clientId: submission.clientUserMessageId,
          content: submission.input,
        },
      ],
      error: null,
    };
    this.turns.push(turn);
    this.status = { type: "active", activeFlags: [] };
    return turn;
  }

  complete(taskId, result = "done") {
    const turn = this.turns.find((candidate) =>
      candidate.items.some(
        (item) => item.type === "userMessage" && item.clientId === taskId,
      ),
    );
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", text: result, phase: "final" });
    this.status = { type: "idle" };
    this.emit("turn/completed", { threadId: "thread-1", turn });
    this.emit("thread/status/changed", {
      threadId: "thread-1",
      status: this.status,
    });
    if (this.queue.length > 0) {
      const next = this.startSubmission(this.queue[0].id);
      this.emit("item/started", {
        threadId: "thread-1",
        turnId: next.id,
        item: next.items[0],
      });
    }
  }
}

async function createProcessor(t, { autoStartOnAdd = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "synapse-host-test-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const store = new HostStore(join(root, "host.sqlite"));
  store.upsertProject({
    alias: "synapse",
    root: projectRoot,
    permissions: ":workspace",
  });
  const appServer = new FakeAppServer({ autoStartOnAdd });
  const statuses = [];
  let worktreeCalls = 0;
  const processor = new TaskProcessor({
    store,
    appServer,
    worktreeRoot: join(root, "worktrees"),
    ensureWorktreeImpl: async ({ conversationId }) => {
      worktreeCalls += 1;
      return {
        path: join(root, "worktrees", conversationId),
        head: "abc123",
      };
    },
    statusSink: (status) => statuses.push(status),
    logger: { error() {} },
  });
  await processor.start();
  t.after(async () => {
    await processor.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    processor,
    store,
    appServer,
    statuses,
    worktreeCalls: () => worktreeCalls,
  };
}

test("a task creates one project-owned Codex thread with the exact prompt", async (t) => {
  const context = await createProcessor(t);
  await context.processor.processTask({
    id: "task-1",
    conversationId: "demo",
    project: "synapse",
    prompt: "Create SYNAPSE.md",
  });

  const threadStart = context.appServer.calls.find((call) => call.method === "thread/start");
  assert.equal(threadStart.params.projectId, "project-1");
  assert.equal(threadStart.params.permissions, ":workspace");
  assert.equal("input" in threadStart.params, false);
  const queueAdd = context.appServer.calls.find((call) => call.method === "thread/queue/add");
  assert.deepEqual(queueAdd.params.input, [{ type: "text", text: "Create SYNAPSE.md" }]);
  assert.equal(queueAdd.params.clientUserMessageId, "task-1");
  assert.equal(context.statuses.at(-1).status, "running");

  context.appServer.complete("task-1", "Created the file");
  await tick();
  assert.equal(context.statuses.at(-1).status, "completed");
  assert.equal(context.statuses.at(-1).result, "Created the file");
});

test("follow-ups reuse the same thread and worktree", async (t) => {
  const context = await createProcessor(t);
  const first = {
    id: "task-1",
    conversationId: "demo",
    project: "synapse",
    prompt: "First",
  };
  await context.processor.processTask(first);
  context.appServer.complete("task-1");
  await tick();
  await context.processor.processTask({ ...first, id: "task-2", prompt: "Second" });
  assert.equal(context.appServer.threadStarts, 1);
  assert.equal(context.worktreeCalls(), 1);
  assert.equal(context.store.getDelivery("task-2").status, "running");
});

test("simultaneous first messages cannot create duplicate conversations", async (t) => {
  const context = await createProcessor(t);
  await Promise.all([
    context.processor.processTask({
      id: "task-1",
      conversationId: "demo",
      project: "synapse",
      prompt: "First",
    }),
    context.processor.processTask({
      id: "task-2",
      conversationId: "demo",
      project: "synapse",
      prompt: "Second",
    }),
  ]);
  assert.equal(context.appServer.threadStarts, 1);
  assert.equal(context.worktreeCalls(), 1);
  assert.equal(
    context.appServer.calls.filter((call) => call.method === "thread/queue/add").length,
    2,
  );
});

test("a busy thread keeps the next task queued until Codex reports idle", async (t) => {
  const context = await createProcessor(t);
  await context.processor.processTask({
    id: "task-1",
    conversationId: "demo",
    project: "synapse",
    prompt: "First",
  });
  await context.processor.processTask({
    id: "task-2",
    conversationId: "demo",
    project: "synapse",
    prompt: "Second",
  });
  assert.equal(context.store.getDelivery("task-2").status, "queued_in_codex");
  assert.equal(
    context.appServer.calls.filter((call) => call.method === "thread/queue/start").length,
    0,
  );

  context.appServer.complete("task-1");
  await tick();
  assert.equal(context.store.getDelivery("task-2").status, "running");
});

test("an idle native queue may auto-promote without downgrading the running status", async (t) => {
  const context = await createProcessor(t);
  await context.processor.processTask({
    id: "task-1",
    conversationId: "demo",
    project: "synapse",
    prompt: "Start immediately",
  });
  assert.equal(context.store.getDelivery("task-1").status, "running");
  assert.equal(context.store.getDelivery("task-1").turnId, "turn-1");
  assert.equal(context.appServer.queue.length, 0);
});

test("unknown projects fail without touching Codex", async (t) => {
  const context = await createProcessor(t);
  await context.processor.processTask({
    id: "task-1",
    conversationId: "demo",
    project: "unknown",
    prompt: "Do it",
  });
  assert.equal(context.statuses.at(-1).status, "failed");
  assert.match(context.statuses.at(-1).error, /project add unknown/);
  assert.equal(context.appServer.threadStarts, 0);
});

test("owner-authored turns are not reported back through Synapse", async (t) => {
  const context = await createProcessor(t);
  const statusesBefore = context.statuses.length;
  context.appServer.emit("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "owner-turn",
      status: "completed",
      error: null,
      items: [
        { type: "userMessage", clientId: null, content: [{ type: "text", text: "private" }] },
        { type: "agentMessage", phase: "final", text: "private answer" },
      ],
    },
  });
  await tick();
  assert.equal(context.statuses.length, statusesBefore);
});
