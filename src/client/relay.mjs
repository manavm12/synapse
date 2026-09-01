import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

import { isLoopbackHost, taskEvent, validateTaskSubmission } from "./protocol.mjs";

const HOST_STATUSES = new Set([
  "accepted",
  "queued_in_codex",
  "running",
  "needs_attention",
  "completed",
  "failed",
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request, maximumBytes = 128 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function taskIdFromPath(pathname, suffix = "") {
  const match = pathname.match(new RegExp(`^/v1/tasks/([^/]+)${suffix}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function createRelay({
  store,
  host = "127.0.0.1",
  port = 8787,
  allowNonLoopback = false,
  logger = console,
} = {}) {
  if (!store) {
    throw new Error("Relay store is required");
  }
  if (!allowNonLoopback && !isLoopbackHost(host)) {
    throw new Error("The mock relay may only bind to a loopback address");
  }

  const events = new EventEmitter();
  const hosts = new Map();
  const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  function publish(task) {
    events.emit(`task:${task.id}`, taskEvent(task));
  }

  function deliverTask(socket, task) {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: "task", task: taskEvent(task) }));
    if (task.status === "queued") {
      const delivered = store.updateTask(task.id, { status: "delivered" });
      publish(delivered);
    }
  }

  function deliverPending(hostId) {
    const socket = hosts.get(hostId);
    if (!socket) {
      return;
    }
    for (const task of store.pendingTasks(hostId)) {
      deliverTask(socket, task);
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, connectedHosts: [...hosts.keys()] });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const input = validateTaskSubmission(await readJson(request));
        const task = store.createTask(input);
        publish(task);
        const socket = hosts.get(task.hostId);
        if (socket) {
          deliverTask(socket, task);
        }
        sendJson(response, 202, { task: taskEvent(store.getTask(task.id)) });
        return;
      }

      const eventTaskId = taskIdFromPath(url.pathname, "/events");
      if (request.method === "GET" && eventTaskId) {
        const task = store.getTask(eventTaskId);
        if (!task) {
          sendJson(response, 404, { error: "Task not found" });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const writeEvent = (event) => {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
          if (event.status === "completed" || event.status === "failed") {
            response.end();
          }
        };
        events.on(`task:${eventTaskId}`, writeEvent);
        response.on("close", () => events.off(`task:${eventTaskId}`, writeEvent));
        writeEvent(taskEvent(task));
        return;
      }

      const taskId = taskIdFromPath(url.pathname);
      if (request.method === "GET" && taskId) {
        const task = store.getTask(taskId);
        if (!task) {
          sendJson(response, 404, { error: "Task not found" });
          return;
        }
        sendJson(response, 200, { task: taskEvent(task) });
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/v1/host") {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });

  webSockets.on("connection", (socket) => {
    let connectedHostId = null;
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "hello") {
          const { hostId } = validateTaskSubmission({
            hostId: message.hostId,
            conversationId: "validation",
            project: "validation",
            prompt: "validation",
          });
          connectedHostId = hostId;
          const previous = hosts.get(hostId);
          if (previous && previous !== socket) {
            previous.close(1000, "Replaced by a newer host connection");
          }
          hosts.set(hostId, socket);
          socket.send(JSON.stringify({ type: "ready", hostId }));
          deliverPending(hostId);
          return;
        }
        if (message.type === "status") {
          if (!connectedHostId) {
            throw new Error("Host must send hello before status events");
          }
          if (hosts.get(connectedHostId) !== socket) {
            throw new Error(`Host connection ${connectedHostId} has been replaced`);
          }
          if (!HOST_STATUSES.has(message.status)) {
            throw new Error(`Unsupported host status: ${message.status}`);
          }
          const existing = store.getTask(message.taskId);
          if (!existing || existing.hostId !== connectedHostId) {
            throw new Error(`Unknown task for host ${connectedHostId}`);
          }
          const task = store.updateTask(message.taskId, {
            status: message.status,
            threadId: message.threadId,
            worktreePath: message.worktreePath,
            result: message.result,
            error: message.error,
          });
          publish(task);
          return;
        }
        throw new Error(`Unsupported host message: ${message.type}`);
      } catch (error) {
        logger.error?.(`[synapse relay] ${error.message}`);
        socket.send(JSON.stringify({ type: "error", error: error.message }));
      }
    });
    socket.on("close", () => {
      if (connectedHostId && hosts.get(connectedHostId) === socket) {
        hosts.delete(connectedHostId);
      }
    });
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      return {
        host,
        port: typeof address === "object" && address ? address.port : port,
      };
    },
    async close() {
      for (const socket of hosts.values()) {
        socket.close(1001, "Relay stopping");
      }
      await new Promise((resolve) => webSockets.close(() => resolve()));
      if (server.listening) {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    deliverPending,
    server,
  };
}
