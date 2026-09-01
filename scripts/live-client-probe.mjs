import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { submitTask } from "../src/client/cli.mjs";
import { HostConnection, TaskProcessor } from "../src/client/host.mjs";
import { createRelay } from "../src/client/relay.mjs";
import { HostStore, RelayStore } from "../src/client/store.mjs";

const execFileAsync = promisify(execFile);

class ProbeAppServer extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.turns = [];
    this.status = { type: "idle" };
    this.threadStarts = 0;
    this.worktreeCwd = null;
  }

  async start() {}
  async close() {}

  async request(method, params) {
    switch (method) {
      case "project/list":
        return { data: [], nextCursor: null };
      case "project/create":
        return { project: { id: "probe-project", roots: params.roots } };
      case "project/read":
        return { project: { id: "probe-project" } };
      case "permissionProfile/list":
        return { data: [{ id: ":workspace", allowed: true }], nextCursor: null };
      case "thread/start":
        this.threadStarts += 1;
        this.worktreeCwd = params.cwd;
        return { thread: { id: "probe-thread" } };
      case "thread/name/set":
      case "thread/resume":
        return {};
      case "thread/read":
        return {
          thread: {
            id: "probe-thread",
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
          id: `queue-${this.queue.length + this.turns.length + 1}`,
          clientUserMessageId: params.clientUserMessageId,
          input: params.input,
        };
        this.queue.push(queuedSubmission);
        if (this.status.type === "idle") {
          this.startSubmission(queuedSubmission.id);
        }
        return { queuedSubmission };
      }
      case "thread/queue/list":
        return { data: [...this.queue], nextCursor: null };
      case "thread/queue/start": {
        return { turn: this.startSubmission(params.queuedSubmissionId) };
      }
      default:
        throw new Error(`Unexpected probe request: ${method}`);
    }
  }

  startSubmission(queuedSubmissionId) {
    const index = this.queue.findIndex((item) => item.id === queuedSubmissionId);
    const [submission] = this.queue.splice(index, 1);
    const prompt = submission.input[0].text;
    const turn = {
      id: `turn-${this.turns.length + 1}`,
      status: "inProgress",
      error: null,
      items: [
        {
          type: "userMessage",
          clientId: submission.clientUserMessageId,
          content: submission.input,
        },
      ],
    };
    this.turns.push(turn);
    this.status = { type: "active", activeFlags: [] };
    this.emit("item/started", {
      threadId: "probe-thread",
      turnId: turn.id,
      item: turn.items[0],
    });
    setImmediate(() => {
      turn.status = "completed";
      turn.items.push({
        type: "agentMessage",
        phase: "final",
        text: `Probe completed: ${prompt}`,
      });
      this.status = { type: "idle" };
      this.emit("turn/completed", { threadId: "probe-thread", turn });
      this.emit("thread/status/changed", {
        threadId: "probe-thread",
        status: this.status,
      });
      if (this.queue.length > 0) {
        this.startSubmission(this.queue[0].id);
      }
    });
    return turn;
  }
}

const probeRoot = await mkdtemp(join(tmpdir(), "synapse-local-cloud-probe-"));
const repository = join(probeRoot, "repository");
const synapseHome = join(probeRoot, "synapse-home");
await mkdir(repository);
await execFileAsync("git", ["init"], { cwd: repository });
await execFileAsync("git", ["config", "user.email", "probe@example.com"], {
  cwd: repository,
});
await execFileAsync("git", ["config", "user.name", "Synapse Probe"], {
  cwd: repository,
});
await writeFile(join(repository, "README.md"), "# Probe\n");
await execFileAsync("git", ["add", "README.md"], { cwd: repository });
await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repository });

const relayStore = new RelayStore(join(synapseHome, "relay.sqlite"));
const hostStore = new HostStore(join(synapseHome, "host.sqlite"));
hostStore.upsertProject({ alias: "probe", root: repository, permissions: ":workspace" });
const relay = createRelay({ relayStore, store: relayStore, port: 0 });
const address = await relay.start();
const relayUrl = `http://${address.host}:${address.port}`;
const appServer = new ProbeAppServer();
const processor = new TaskProcessor({
  store: hostStore,
  appServer,
  worktreeRoot: join(synapseHome, "worktrees"),
});
const host = new HostConnection({ processor, relayUrl, hostId: "local" });

let output;
try {
  await host.start();
  const firstEvents = [];
  const first = await submitTask(
    {
      relayUrl,
      hostId: "local",
      conversationId: "demo",
      project: "probe",
      prompt: "first task",
    },
    { onEvent: (event) => firstEvents.push(event.status) },
  );
  const second = await submitTask({
    relayUrl,
    hostId: "local",
    conversationId: "demo",
    project: "probe",
    prompt: "follow-up task",
  });

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(first.threadId, second.threadId);
  assert.equal(first.worktreePath, second.worktreePath);
  assert.equal(appServer.threadStarts, 1);
  assert.equal(appServer.worktreeCwd, first.worktreePath);
  assert.ok(firstEvents.includes("running"));
  assert.ok(firstEvents.includes("completed"));

  output = {
    relayUrl,
    threadId: first.threadId,
    worktreePath: first.worktreePath,
    firstStatuses: firstEvents,
    results: [first.result, second.result],
  };
} finally {
  await host.stop();
  await relay.close();
  hostStore.close();
  relayStore.close();
  await rm(probeRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
