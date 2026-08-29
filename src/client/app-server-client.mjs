import WebSocket from "ws";

export class AppServerClient {
  constructor({ socketPath, timeoutMs = 300_000 }) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.socket = null;
  }

  async start() {
    this.socket = new WebSocket(`ws+unix://${this.socketPath}:/`, {
      handshakeTimeout: 5_000,
      perMessageDeflate: false,
    });
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (data) => this.#handleMessage(data.toString()));
    this.socket.on("error", (error) => this.#rejectAll(error));
    this.socket.on("close", () => this.#rejectAll(new Error("Codex App Server disconnected")));

    await this.request("initialize", {
      clientInfo: { name: "synapse-client", title: "Synapse Client", version: "0.1.0" },
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
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }

  #send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Codex App Server is not running");
    }
    this.socket.send(JSON.stringify(message));
  }

  #handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`Ignoring non-JSON App Server output: ${line}\n`);
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
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
      this.#send({
        id: message.id,
        error: { code: -32601, message: `Unsupported client method: ${message.method}` },
      });
      return;
    }

    if (!message.method) {
      return;
    }
    if (
      message.method === "error" ||
      message.method === "item/autoApprovalReview/completed"
    ) {
      process.stderr.write(`${JSON.stringify(message)}\n`);
    }
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
