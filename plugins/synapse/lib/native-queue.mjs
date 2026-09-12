import { spawn } from "node:child_process";

// Connect to the existing desktop daemon. Never start a separate app-server:
// that would compete for the user's task and lose desktop queue coordination.
export class NativeQueueClient {
  constructor({
    codexPath = process.env.SYNAPSE_CODEX_PATH ?? "codex",
    socketPath = process.env.SYNAPSE_CODEX_SOCKET,
    timeoutMs = 10_000,
    spawnProcess = spawn,
  } = {}) {
    this.codexPath = codexPath;
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = "";
  }

  async start() {
    if (this.child) return;
    this.child = this.spawnProcess(
      this.codexPath,
      [
        "app-server",
        "proxy",
        ...(this.socketPath ? ["--sock", this.socketPath] : []),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
        this.fail(new Error("Native queue response is too large"));
        this.child.kill();
        return;
      }
      while (this.buffer.includes("\n")) {
        const newline = this.buffer.indexOf("\n");
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          this.fail(new Error("Invalid native queue response"));
          continue;
        }
        if (!value || typeof value !== "object") {
          this.fail(new Error("Invalid native queue response"));
          continue;
        }
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        this.pending.delete(value.id);
        if (value.error)
          pending.reject(
            Object.assign(
              new Error(value.error.message ?? "Native queue unavailable"),
              { nativeCode: value.error.code },
            ),
          );
        else pending.resolve(value.result);
      }
    });
    this.child.stderr.resume();
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", () =>
      this.fail(new Error("Codex queue connection closed")),
    );
    await this.request("initialize", {
      clientInfo: { name: "synapse_receiver", version: "0.4.0" },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  }

  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async prepare(threadId) {
    await this.start();
    const read = await this.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    if (read?.thread?.id !== threadId)
      throw new Error("Destination task is unavailable");
    // thread/read also reads archived tasks. Prove membership in the live list
    // before dispatch; never unarchive or restore a destination implicitly.
    let cursor;
    let found = false;
    do {
      const page = await this.request("thread/list", {
        archived: false,
        cwd: read.thread.cwd,
        limit: 100,
        sourceKinds: [
          "cli",
          "vscode",
          "exec",
          "appServer",
          "subAgent",
          "subAgentReview",
          "subAgentCompact",
          "subAgentThreadSpawn",
          "subAgentOther",
          "unknown",
        ],
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page?.data))
        throw new Error("Native task listing is unavailable");
      found = page.data.some((thread) => thread.id === threadId);
      cursor = page.nextCursor;
    } while (!found && cursor);
    if (!found)
      throw new Error(
        "Destination task is archived or unavailable; restore it before resuming",
      );
    // This is also a capability probe, before any mutating call is issued.
    const queue = await this.request("thread/queue/list", {
      threadId,
      limit: 1,
    });
    if (!Array.isArray(queue?.data))
      throw new Error("Native queue is unavailable; update Codex");
    return read.thread;
  }

  async submit({ threadId, prompt, deliveryId }) {
    const result = await this.request("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      clientUserMessageId: `synapse-${deliveryId}`,
    });
    if (
      typeof result?.queuedSubmission?.id !== "string" ||
      result.queuedSubmission.clientUserMessageId !== `synapse-${deliveryId}`
    ) {
      throw new Error("Codex did not acknowledge the queued delivery");
    }
    return result.queuedSubmission;
  }

  fail(error) {
    for (const value of this.pending.values()) value.reject(error);
    this.pending.clear();
  }

  close() {
    this.fail(new Error("Native queue client closed"));
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
  }
}
