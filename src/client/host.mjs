import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import WebSocket from "ws";

import { relayWebSocketUrl } from "./config.mjs";
import { ensureWorktree } from "./worktree.mjs";

function finalAgentMessage(turn) {
  return [...(turn.items ?? [])]
    .reverse()
    .find((item) => item.type === "agentMessage" && item.phase !== "commentary")?.text ?? "";
}

function clientMessageId(turn) {
  return (turn.items ?? []).find((item) => item.type === "userMessage")?.clientId ?? null;
}

function isTerminalDelivery(delivery) {
  return delivery?.status === "completed" || delivery?.status === "failed";
}

export class TaskProcessor {
  constructor({
    store,
    appServer,
    worktreeRoot,
    ensureWorktreeImpl = ensureWorktree,
    statusSink = () => {},
    logger = console,
  }) {
    this.store = store;
    this.appServer = appServer;
    this.worktreeRoot = worktreeRoot;
    this.ensureWorktree = ensureWorktreeImpl;
    this.statusSink = statusSink;
    this.logger = logger;
    this.subscribedThreads = new Set();
    this.processingConversations = new Map();
  }

  setStatusSink(statusSink) {
    this.statusSink = statusSink;
  }

  async start() {
    this.appServer.on("turn/started", (params) => {
      this.#handleTurnStarted(params).catch((error) => this.#log(error));
    });
    this.appServer.on("turn/completed", (params) => {
      this.#handleTurnCompleted(params).catch((error) => this.#log(error));
    });
    this.appServer.on("item/started", (params) => {
      this.#handleItemStarted(params).catch((error) => this.#log(error));
    });
    this.appServer.on("serverRequest", (request) => {
      this.#handleServerRequest(request).catch((error) => this.#log(error));
    });
    await this.appServer.start();
  }

  async stop() {
    await this.appServer.close();
  }

  processTask(task) {
    const previous = this.processingConversations.get(task.conversationId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#processTask(task));
    this.processingConversations.set(task.conversationId, current);
    return current.finally(() => {
      if (this.processingConversations.get(task.conversationId) === current) {
        this.processingConversations.delete(task.conversationId);
      }
    });
  }

  async #processTask(task) {
    try {
      const project = this.store.getProject(task.project);
      if (!project) {
        throw new Error(
          `Project ${task.project} is not registered on this laptop. Run ` +
            `\`synapse project add ${task.project} /absolute/path\`.`,
        );
      }

      let conversation = this.store.getConversation(task.conversationId);
      if (conversation && conversation.project !== task.project) {
        throw new Error(
          `Conversation ${task.conversationId} is pinned to project ${conversation.project}`,
        );
      }

      if (!conversation) {
        conversation = await this.#createConversation(task, project);
      } else {
        await this.#subscribe(conversation.threadId);
      }

      let delivery = this.store.getDelivery(task.id);
      if (!delivery) {
        delivery = this.store.createDelivery({
          taskId: task.id,
          conversationId: task.conversationId,
        });
      }

      if (isTerminalDelivery(delivery)) {
        this.#sendDeliveryStatus(delivery, conversation);
        return;
      }

      const reconciled = await this.#reconcileDelivery(delivery, conversation);
      if (reconciled === "terminal" || reconciled === "running") {
        return;
      }

      delivery = this.store.getDelivery(task.id);
      if (!delivery.queuedSubmissionId) {
        const queued = await this.#findQueuedSubmission(conversation.threadId, task.id);
        let queuedSubmission = queued;
        if (!queuedSubmission) {
          this.store.updateDelivery(task.id, { status: "starting" });
          queuedSubmission = (
            await this.appServer.request("thread/queue/add", {
              threadId: conversation.threadId,
              clientUserMessageId: task.id,
              input: [{ type: "text", text: task.prompt }],
            })
          ).queuedSubmission;
        }
        const current = this.store.getDelivery(task.id);
        delivery = this.store.updateDelivery(task.id, {
          queuedSubmissionId: queuedSubmission.id,
          ...(current.status === "received" || current.status === "starting"
            ? { status: "queued_in_codex" }
            : {}),
        });
      }

      this.#sendDeliveryStatus(delivery, conversation);
    } catch (error) {
      const existing = this.store.getDelivery(task.id);
      if (existing) {
        this.store.updateDelivery(task.id, { status: "failed", error: error.message });
      }
      this.statusSink({ type: "status", taskId: task.id, status: "failed", error: error.message });
    }
  }

  async #createConversation(task, project) {
    const codexProjectId = await this.#ensureCodexProject(project);
    await this.#validatePermissions(project);
    const worktree = await this.ensureWorktree({
      projectRoot: project.root,
      worktreeRoot: this.worktreeRoot,
      conversationId: task.conversationId,
    });
    const { thread } = await this.appServer.request("thread/start", {
      cwd: worktree.path,
      projectId: codexProjectId,
      permissions: project.permissions,
      approvalsReviewer: "user",
      serviceName: "Synapse",
      threadSource: "synapse",
    });
    await this.appServer.request("thread/name/set", {
      threadId: thread.id,
      name: `Synapse: ${task.conversationId}`,
    });
    const conversation = this.store.createConversation({
      id: task.conversationId,
      project: task.project,
      threadId: thread.id,
      worktreePath: worktree.path,
      sourceHead: worktree.head,
    });
    this.subscribedThreads.add(thread.id);
    return conversation;
  }

  async #ensureCodexProject(project) {
    if (project.codexProjectId) {
      try {
        const response = await this.appServer.request("project/read", {
          projectId: project.codexProjectId,
        });
        return response.project.id;
      } catch {
        // Re-resolve a project that was deleted from Codex.
      }
    }

    const root = await realpath(project.root);
    let cursor = null;
    do {
      const page = await this.appServer.request("project/list", { cursor, limit: 100 });
      const match = page.data.find((candidate) =>
        candidate.roots.some((candidateRoot) => candidateRoot.path === root),
      );
      if (match) {
        this.store.setCodexProjectId(project.alias, match.id);
        return match.id;
      }
      cursor = page.nextCursor;
    } while (cursor);

    const idempotencyKey = createHash("sha256")
      .update(`synapse-project\0${root}`)
      .digest("hex");
    const { project: created } = await this.appServer.request("project/create", {
      name: project.alias,
      roots: [{ path: root }],
      idempotencyKey,
      metadata: { createdBy: "synapse" },
    });
    this.store.setCodexProjectId(project.alias, created.id);
    return created.id;
  }

  async #validatePermissions(project) {
    const response = await this.appServer.request("permissionProfile/list", {
      cwd: project.root,
      limit: 100,
    });
    const profile = response.data.find((candidate) => candidate.id === project.permissions);
    if (!profile) {
      throw new Error(`Unknown Codex permission profile: ${project.permissions}`);
    }
    if (!profile.allowed) {
      throw new Error(`Codex permission profile is blocked by policy: ${project.permissions}`);
    }
  }

  async #subscribe(threadId) {
    if (this.subscribedThreads.has(threadId)) {
      return;
    }
    await this.appServer.request("thread/resume", { threadId });
    this.subscribedThreads.add(threadId);
  }

  async #listQueue(threadId) {
    const submissions = [];
    let cursor = null;
    do {
      const page = await this.appServer.request("thread/queue/list", {
        threadId,
        cursor,
        limit: 100,
      });
      submissions.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return submissions;
  }

  async #findQueuedSubmission(threadId, taskId) {
    return (await this.#listQueue(threadId)).find(
      (submission) => submission.clientUserMessageId === taskId,
    );
  }

  async #reconcileDelivery(delivery, conversation) {
    const { thread } = await this.appServer.request("thread/read", {
      threadId: conversation.threadId,
      includeTurns: true,
    });
    let turn = thread.turns.find(
      (candidate) =>
        candidate.id === delivery.turnId || clientMessageId(candidate) === delivery.taskId,
    );
    if (!turn) {
      const items = await this.appServer.request("thread/items/list", {
        threadId: conversation.threadId,
        limit: 100,
        sortDirection: "desc",
      });
      const entry = items.data.find(
        (candidate) =>
          candidate.item.type === "userMessage" &&
          candidate.item.clientId === delivery.taskId,
      );
      if (entry) {
        turn = thread.turns.find((candidate) => candidate.id === entry.turnId) ?? {
          id: entry.turnId,
          status: thread.status?.type === "active" ? "inProgress" : "completed",
          items: items.data
            .filter((candidate) => candidate.turnId === entry.turnId)
            .map((candidate) => candidate.item),
          error: null,
        };
      }
    }
    if (!turn) {
      return "absent";
    }
    if (turn.status === "inProgress") {
      const updated = this.store.updateDelivery(delivery.taskId, {
        turnId: turn.id,
        status: "running",
      });
      this.#sendDeliveryStatus(updated, conversation);
      return "running";
    }
    await this.#finishDelivery(turn, delivery, conversation);
    return "terminal";
  }

  async #handleTurnStarted({ threadId, turn }) {
    const taskId = clientMessageId(turn);
    const delivery = taskId ? this.store.getDelivery(taskId) : null;
    if (!delivery) {
      return;
    }
    const updated = this.store.updateDelivery(taskId, {
      turnId: turn.id,
      status: "running",
    });
    const conversation = this.store.getConversation(updated.conversationId);
    if (conversation?.threadId === threadId) {
      this.#sendDeliveryStatus(updated, conversation);
    }
  }

  async #handleItemStarted({ threadId, turnId, item }) {
    if (item.type !== "userMessage" || !item.clientId) {
      return;
    }
    const delivery = this.store.getDelivery(item.clientId);
    if (!delivery) {
      return;
    }
    const updated = this.store.updateDelivery(item.clientId, {
      turnId,
      status: "running",
    });
    const conversation = this.store.getConversation(updated.conversationId);
    if (conversation?.threadId === threadId) {
      this.#sendDeliveryStatus(updated, conversation);
    }
  }

  async #handleTurnCompleted({ threadId, turn }) {
    const taskId = clientMessageId(turn);
    const delivery =
      this.store.deliveryForTurn(turn.id) ?? (taskId ? this.store.getDelivery(taskId) : null);
    if (delivery) {
      const conversation = this.store.getConversation(delivery.conversationId);
      if (conversation?.threadId === threadId) {
        await this.#finishDelivery(turn, delivery, conversation);
      }
    }
  }

  async #finishDelivery(turn, delivery, conversation) {
    const completed = turn.status === "completed";
    const error = completed
      ? null
      : turn.error?.message ?? `Codex turn ended with status ${turn.status}`;
    const updated = this.store.updateDelivery(delivery.taskId, {
      turnId: turn.id,
      status: completed ? "completed" : "failed",
      result: completed ? finalAgentMessage(turn) : null,
      error,
    });
    this.#sendDeliveryStatus(updated, conversation);
  }

  async #handleServerRequest(request) {
    const threadId = request.params?.threadId;
    const turnId = request.params?.turnId;
    const delivery = turnId ? this.store.deliveryForTurn(turnId) : null;
    if (!delivery) {
      this.logger.error?.(
        `[synapse host] Codex requested owner input for thread ${threadId ?? "unknown"}`,
      );
      return;
    }
    const updated = this.store.updateDelivery(delivery.taskId, {
      status: "needs_attention",
    });
    const conversation = this.store.getConversation(updated.conversationId);
    this.#sendDeliveryStatus(updated, conversation);
  }

  #sendDeliveryStatus(delivery, conversation) {
    this.statusSink({
      type: "status",
      taskId: delivery.taskId,
      status: delivery.status,
      threadId: conversation?.threadId ?? null,
      worktreePath: conversation?.worktreePath ?? null,
      result: delivery.result,
      error: delivery.error,
    });
  }

  #log(error) {
    this.logger.error?.(`[synapse host] ${error.stack ?? error.message}`);
  }
}

export class HostConnection {
  constructor({
    processor,
    relayUrl,
    hostId = "local",
    createWebSocket = (url) => new WebSocket(url, { perMessageDeflate: false }),
    logger = console,
  }) {
    this.processor = processor;
    this.relayUrl = relayUrl;
    this.hostId = hostId;
    this.createWebSocket = createWebSocket;
    this.logger = logger;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = 250;
    this.stopping = false;
    this.readyPromise = null;
  }

  async start() {
    await this.processor.start();
    this.processor.setStatusSink((message) => this.#send(message));
    this.readyPromise = new Promise((resolve) => {
      this.#connect(resolve);
    });
    return this.readyPromise;
  }

  async stop() {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close(1000, "Synapse host stopping");
      this.socket = null;
    }
    await this.processor.stop();
  }

  #connect(resolveFirst) {
    const socket = this.createWebSocket(relayWebSocketUrl(this.relayUrl));
    this.socket = socket;
    let becameReady = false;
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "hello", hostId: this.hostId }));
    });
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "ready") {
          becameReady = true;
          this.reconnectDelayMs = 250;
          resolveFirst?.();
          return;
        }
        if (message.type === "task") {
          this.processor.processTask(message.task).catch((error) => {
            this.logger.error?.(`[synapse host] ${error.stack ?? error.message}`);
          });
          return;
        }
        if (message.type === "error") {
          this.logger.error?.(`[synapse relay] ${message.error}`);
        }
      } catch (error) {
        this.logger.error?.(`[synapse host] Invalid relay message: ${error.message}`);
      }
    });
    socket.once("error", (error) => {
      if (!becameReady) {
        this.logger.error?.(`[synapse host] Relay connection failed: ${error.message}`);
      }
    });
    socket.once("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (!this.stopping) {
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10_000);
        this.reconnectTimer = setTimeout(() => this.#connect(), delay);
      }
    });
  }

  #send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
