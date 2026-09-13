import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { posix } from "node:path";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function appToolsPipePath(env = process.env) {
  const path = env.CODEX_APP_TOOLS_PIPE_PATH;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error(
      "Codex desktop app-tools pipe is unavailable (CODEX_APP_TOOLS_PIPE_PATH is not set)",
    );
  }
  // A Windows named pipe lives in the \\.\pipe\ device namespace, which path
  // resolution would corrupt -- pass it through unchanged.
  if (/^\\\\[.?]\\pipe\\/.test(path)) return path;
  // Resolve with posix semantics so a real POSIX socket path is not
  // reinterpreted using the local OS's drive/separator rules.
  return posix.resolve(path);
}

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new Error("Codex app-tools request is too large");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export function appToolText(result) {
  const text = (result?.contentItems ?? [])
    .filter((item) => item?.type === "inputText")
    .map((item) => item.text)
    .join("\n");
  if (result?.success !== true) {
    throw new Error(text || "Codex app tool failed");
  }
  return text;
}

export function appToolJson(result) {
  const text = appToolText(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Codex app tool returned invalid JSON");
  }
}

export class AppToolsClient {
  constructor({
    pipePath = appToolsPipePath(),
    timeoutMs = 15_000,
    connect = createConnection,
    signal,
  } = {}) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.connect = connect;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.socket = null;
    this.connecting = null;
    this.tools = null;
    this.signal = signal;
    this.abort = () => {
      this.connectAbort?.(signal.reason);
      this.#rejectAll(signal.reason);
      this.socket?.destroy();
    };
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  async start() {
    this.signal?.throwIfAborted();
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolvePromise, reject) => {
      const socket = this.connect(this.pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out connecting to Codex desktop app tools"));
      }, this.timeoutMs);
      const failed = (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      this.connectAbort = failed;
      socket.once("error", failed);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", failed);
        this.socket = socket;
        socket.on("data", (chunk) => this.#handleData(socket, chunk));
        socket.on("error", (error) => this.#disconnect(socket, error));
        socket.on("close", () =>
          this.#disconnect(socket, new Error("Codex app-tools pipe closed")),
        );
        resolvePromise();
      });
    }).finally(() => {
      this.connectAbort = null;
      this.connecting = null;
    });
    return this.connecting;
  }

  async request(method, params) {
    await this.start();
    this.signal?.throwIfAborted();
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("Codex app-tools pipe is unavailable");
    }
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    socket.write(encodeFrame({ id, jsonrpc: "2.0", method, params }));
    return response;
  }

  async listTools() {
    const response = await this.request("tools/list", {
      threadStartKind: "all",
    });
    if (!Array.isArray(response?.tools)) {
      throw new Error("Codex app-tools catalog is invalid");
    }
    this.tools = new Map(response.tools.map((tool) => [tool.name, tool]));
    return response.tools;
  }

  async callTool(
    name,
    arguments_,
    { threadId, turnId = `synapse-turn-${randomUUID()}` } = {},
  ) {
    if (typeof threadId !== "string" || threadId.trim() === "") {
      throw new Error("Codex app tool calls require an owner task ID");
    }
    if (!this.tools) await this.listTools();
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Codex app tool is unavailable: ${name}`);
    const result = await this.request("tools/call", {
      arguments: arguments_ ?? {},
      callId: `synapse-call-${randomUUID()}`,
      namespace: tool.namespace,
      threadId,
      tool: name,
      turnId,
    });
    appToolText(result);
    return result;
  }

  async close() {
    this.signal?.removeEventListener("abort", this.abort);
    this.connectAbort?.(new Error("Codex app-tools client closed"));
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.tools = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.#rejectAll(new Error("Codex app-tools client closed"));
  }

  #handleData(socket, chunk) {
    if (this.socket !== socket) return;
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.byteLength >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (length > MAX_FRAME_BYTES) {
          throw new Error("Codex app-tools response is too large");
        }
        if (this.buffer.byteLength < length + 4) return;
        const payload = this.buffer.subarray(4, length + 4);
        this.buffer = this.buffer.subarray(length + 4);
        let message;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch {
          throw new Error("Codex app tools returned invalid JSON");
        }
        const pending = this.pending.get(Number(message?.id));
        if (!pending) continue;
        this.pending.delete(Number(message.id));
        if (message.error) {
          pending.reject(
            new Error(
              `${message.error.message || "Codex app-tools request failed"} (${message.error.code})`,
            ),
          );
        } else if (Object.hasOwn(message, "result")) {
          pending.resolve(message.result);
        } else {
          pending.reject(
            new Error("Codex app tools returned an invalid response"),
          );
        }
      }
    } catch (error) {
      socket.destroy();
      this.#disconnect(socket, error);
    }
  }

  #disconnect(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.#rejectAll(error);
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
