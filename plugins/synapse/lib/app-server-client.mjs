import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export function appServerSocketPath(env = process.env) {
  return resolve(
    env.CODEX_APP_SERVER_SOCKET ??
      join(
        env.CODEX_HOME ?? join(homedir(), ".codex"),
        "app-server-control",
        "app-server-control.sock",
      ),
  );
}

function websocketFrame(opcode, payload, mask = randomBytes(4)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new Error("Codex App Server message is too large");
  }
  const width = body.byteLength < 126 ? 0 : body.byteLength <= 0xffff ? 2 : 8;
  const frame = Buffer.allocUnsafe(2 + width + 4 + body.byteLength);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (width === 0 ? body.byteLength : width === 2 ? 126 : 127);
  let offset = 2;
  if (width === 2) {
    frame.writeUInt16BE(body.byteLength, offset);
    offset += 2;
  } else if (width === 8) {
    frame.writeBigUInt64BE(BigInt(body.byteLength), offset);
    offset += 8;
  }
  mask.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < body.byteLength; index += 1) {
    frame[offset + index] = body[index] ^ mask[index % 4];
  }
  return frame;
}

function parseFrame(buffer) {
  if (buffer.byteLength < 2) return null;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.byteLength < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.byteLength < 10) return null;
    const wide = buffer.readBigUInt64BE(2);
    if (wide > BigInt(MAX_FRAME_BYTES)) {
      throw new Error("Codex App Server frame is too large");
    }
    length = Number(wide);
    offset = 10;
  }
  if (length > MAX_FRAME_BYTES) {
    throw new Error("Codex App Server frame is too large");
  }
  const maskWidth = masked ? 4 : 0;
  if (buffer.byteLength < offset + maskWidth + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskWidth;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.byteLength; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return {
    fin: (buffer[0] & 0x80) !== 0,
    opcode: buffer[0] & 0x0f,
    payload,
    consumed: offset + length,
  };
}

export class AppServerClient {
  constructor({
    socketPath = appServerSocketPath(),
    timeoutMs = 15_000,
    connect = createConnection,
    createKey = () => randomBytes(16).toString("base64"),
  } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.connect = connect;
    this.createKey = createKey;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.handshakeKey = null;
    this.fragmentOpcode = null;
    this.fragments = [];
  }

  async start() {
    if (this.socket) return;
    const socket = this.connect(this.socketPath);
    this.socket = socket;
    socket.on("data", (chunk) => this.#handleData(chunk));
    socket.on("error", (error) => {
      this.handshakeReject?.(error);
      this.#rejectAll(error);
    });
    socket.on("close", () => {
      this.socket = null;
      const error = new Error("Codex App Server disconnected");
      this.handshakeReject?.(error);
      this.#rejectAll(error);
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out connecting to Codex App Server")),
        this.timeoutMs,
      );
      socket.once("connect", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.handshakeKey = this.createKey();
    const handshake = [
      "GET / HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${this.handshakeKey}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n");
    const ready = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error("Timed out upgrading the Codex App Server socket")),
        this.timeoutMs,
      );
      this.handshakeResolve = () => {
        clearTimeout(timer);
        resolvePromise();
      };
      this.handshakeReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    socket.write(handshake);
    await ready;

    await this.request("initialize", {
      clientInfo: {
        name: "synapse",
        title: "Synapse",
        version: "0.2.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolvePromise,
        reject,
        timer,
      });
    });
    this.#send({ method, id, params });
    return response;
  }

  notify(method, params) {
    this.#send({ method, params });
  }

  async close() {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    if (!socket.destroyed && this.handshakeComplete) {
      socket.write(websocketFrame(0x8, Buffer.alloc(0)));
    }
    socket.end();
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolvePromise();
      }, 500);
      socket.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    this.#rejectAll(new Error("Codex App Server client closed"));
  }

  #send(message) {
    if (!this.socket || !this.handshakeComplete || this.socket.destroyed) {
      throw new Error("Codex App Server socket is unavailable");
    }
    this.socket.write(websocketFrame(0x1, JSON.stringify(message)));
  }

  #handleData(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (!this.handshakeComplete && !this.#consumeHandshake()) return;
      let frame = parseFrame(this.buffer);
      while (frame) {
        this.buffer = this.buffer.subarray(frame.consumed);
        this.#handleFrame(frame);
        frame = parseFrame(this.buffer);
      }
    } catch (error) {
      this.handshakeReject?.(error);
      this.#rejectAll(error);
      this.socket?.destroy();
    }
  }

  #consumeHandshake() {
    const boundary = this.buffer.indexOf("\r\n\r\n");
    if (boundary === -1) return false;
    const headers = this.buffer.subarray(0, boundary).toString("utf8");
    this.buffer = this.buffer.subarray(boundary + 4);
    const expected = createHash("sha1")
      .update(`${this.handshakeKey}${WEBSOCKET_GUID}`)
      .digest("base64");
    if (!headers.startsWith("HTTP/1.1 101 ")) {
      throw new Error(
        `Codex App Server rejected WebSocket upgrade: ${headers}`,
      );
    }
    const accepted = headers
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"))
      ?.slice("sec-websocket-accept:".length)
      .trim();
    if (accepted !== expected) {
      throw new Error(
        "Codex App Server returned an invalid WebSocket handshake",
      );
    }
    this.handshakeComplete = true;
    this.handshakeResolve?.();
    return true;
  }

  #handleFrame(frame) {
    if (frame.opcode === 0x8) {
      this.socket?.end();
      return;
    }
    if (frame.opcode === 0x9) {
      this.socket?.write(websocketFrame(0xa, frame.payload));
      return;
    }
    if (frame.opcode !== 0x0 && frame.opcode !== 0x1) return;
    if (frame.opcode === 0x1) {
      this.fragmentOpcode = frame.opcode;
      this.fragments = [frame.payload];
    } else if (this.fragmentOpcode !== null) {
      this.fragments.push(frame.payload);
    }
    if (!frame.fin || this.fragmentOpcode === null) return;
    const text = Buffer.concat(this.fragments).toString("utf8");
    this.fragmentOpcode = null;
    this.fragments = [];
    this.#handleMessage(text);
  }

  #handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#send({
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported Synapse client method: ${message.method}`,
        },
      });
      return;
    }
    if (message.id === undefined || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
