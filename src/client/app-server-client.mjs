import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import WebSocket from "ws";

import { CODEX_BINARY, PATHS } from "./config.mjs";

export class AppServerClient extends EventEmitter {
  constructor({
    codexBinary = CODEX_BINARY,
    codexArguments = null,
    socketPath = PATHS.appServerSocket,
    timeoutMs = 300_000,
    spawnProcess = spawn,
    logger = console,
  } = {}) {
    super();
    this.codexBinary = codexBinary;
    this.codexArguments = codexArguments;
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.child = null;
    this.input = null;
    this.lines = null;
    this.stderr = "";
    this.socket = null;
  }

  async start() {
    if (this.child || this.socket) {
      return;
    }
    if (!this.codexArguments) {
      const socket = new WebSocket(`ws+unix://${this.socketPath}:/`, {
        handshakeTimeout: 5_000,
        perMessageDeflate: false,
      });
      this.socket = socket;
      try {
        await new Promise((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
      } catch (error) {
        this.socket = null;
        socket.terminate();
        throw error;
      }
      socket.on("message", (data) => this.#handleMessage(data.toString()));
      socket.on("error", (error) => this.#rejectAll(error));
      socket.on("close", () => {
        this.socket = null;
        this.#rejectAll(new Error("Codex App Server disconnected"));
        this.emit("disconnect");
      });
      await this.#initialize();
      return;
    }
    const child = this.spawnProcess(this.codexBinary, this.codexArguments, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.input = child.stdin;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.#handleMessage(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.once("error", (error) => this.#rejectAll(error));
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.#rejectAll(
        new Error(`Codex App Server proxy exited (${signal ?? code ?? "unknown"})${suffix}`),
      );
      this.emit("disconnect");
    });

    await this.#initialize();
  }

  async #initialize() {
    await this.request("initialize", {
      clientInfo: { name: "synapse-host", title: "Synapse Host", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.#send({ method, id, params });
    return promise;
  }

  notify(method, params) {
    this.#send({ method, params });
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  reject(id, code, message) {
    this.#send({ id, error: { code, message } });
  }

  waitFor(method, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error(`Timed out waiting for notification ${method}`));
      }, this.timeoutMs);
      this.waiters.push({ method, predicate, resolve, reject, timer });
    });
  }

  async close() {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close(1000, "Synapse host stopping");
      });
      this.#rejectAll(new Error("Codex App Server client closed"));
      return;
    }
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.input?.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.#rejectAll(new Error("Codex App Server client closed"));
  }

  #send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (!this.input || this.input.destroyed || !this.input.writable) {
      throw new Error(
        "Codex App Server is unavailable. Run `codex remote-control start` first.",
      );
    }
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  #handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.error?.(`[synapse host] Ignoring non-JSON App Server output: ${line}`);
      return;
    }

    if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (!message.method) {
      return;
    }

    this.emit("notification", message);
    this.emit(message.method, message.params);
    const matching = this.waiters.filter(
      (waiter) => waiter.method === message.method && waiter.predicate(message.params),
    );
    this.waiters = this.waiters.filter((waiter) => !matching.includes(waiter));
    for (const waiter of matching) {
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }
}
