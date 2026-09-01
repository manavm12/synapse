import { resolve } from "node:path";

import { AppServerClient } from "./app-server-client.mjs";
import { CODEX_BINARY, PATHS, RELAY_URL } from "./config.mjs";
import { HostConnection, TaskProcessor } from "./host.mjs";
import { requireIdentifier, TERMINAL_TASK_STATUSES } from "./protocol.mjs";
import { createRelay } from "./relay.mjs";
import { HostStore, RelayStore } from "./store.mjs";
import { resolveGitProjectRoot } from "./worktree.mjs";

function usage() {
  return [
    "Usage:",
    "  npm run synapse -- relay run [--host 127.0.0.1] [--port 8787]",
    "  npm run synapse -- host run [--id local] [--relay http://127.0.0.1:8787]",
    "  npm run synapse -- project add <alias> <path> [--permissions :workspace]",
    "  npm run synapse -- project list",
    '  npm run synapse -- send <conversation-id> --project <alias> "<task>"',
    "  npm run synapse -- status <task-id>",
    "",
    "The send command posts to the local mock cloud. The relay pushes the task",
    "over WebSocket to the laptop host, which creates or resumes a Codex task.",
  ].join("\n");
}

function takeFlag(arguments_, name, fallback = null) {
  const index = arguments_.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value\n\n${usage()}`);
  }
  arguments_.splice(index, 2);
  return value;
}

function takeBooleanFlag(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index === -1) {
    return false;
  }
  arguments_.splice(index, 1);
  return true;
}

export function parseArguments(input) {
  const arguments_ = [...input];
  if (arguments_.includes("--help") || arguments_.includes("-h") || arguments_.length === 0) {
    return { command: "help" };
  }

  if (arguments_[0] === "relay" && arguments_[1] === "run") {
    arguments_.splice(0, 2);
    const host = takeFlag(arguments_, "--host", "127.0.0.1");
    const portText = takeFlag(arguments_, "--port", "8787");
    const port = Number.parseInt(portText, 10);
    if (arguments_.length > 0 || !Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(usage());
    }
    return { command: "relay-run", host, port };
  }

  if (arguments_[0] === "host" && arguments_[1] === "run") {
    arguments_.splice(0, 2);
    const hostId = takeFlag(arguments_, "--id", "local");
    const relayUrl = takeFlag(arguments_, "--relay", RELAY_URL);
    if (arguments_.length > 0) {
      throw new Error(usage());
    }
    return { command: "host-run", hostId, relayUrl };
  }

  if (arguments_[0] === "project" && arguments_[1] === "add") {
    arguments_.splice(0, 2);
    const permissions = takeFlag(arguments_, "--permissions", ":workspace");
    const [alias, path, ...extra] = arguments_;
    if (!alias || !path || extra.length > 0) {
      throw new Error(usage());
    }
    return { command: "project-add", alias, path, permissions };
  }

  if (arguments_[0] === "project" && arguments_[1] === "list" && arguments_.length === 2) {
    return { command: "project-list" };
  }

  if (arguments_[0] === "status") {
    const relayUrl = takeFlag(arguments_, "--relay", RELAY_URL);
    const [, taskId, ...extra] = arguments_;
    if (!taskId || extra.length > 0) {
      throw new Error(usage());
    }
    return { command: "status", taskId, relayUrl };
  }

  if (arguments_[0] === "send") {
    const project = takeFlag(arguments_, "--project");
    const hostId = takeFlag(arguments_, "--host", "local");
    const relayUrl = takeFlag(arguments_, "--relay", RELAY_URL);
    const noWait = takeBooleanFlag(arguments_, "--no-wait");
    const [, conversationId, ...promptParts] = arguments_;
    const prompt = promptParts.join(" ").trim();
    if (!project || !conversationId || !prompt) {
      throw new Error(usage());
    }
    return {
      command: "send",
      conversationId,
      project,
      hostId,
      relayUrl,
      prompt,
      wait: !noWait,
    };
  }

  throw new Error(usage());
}

async function responseJson(response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? `Relay request failed with HTTP ${response.status}`);
  }
  return body;
}

async function watchTask(relayUrl, taskId, onEvent, fetchImpl) {
  const response = await fetchImpl(
    new URL(`/v1/tasks/${encodeURIComponent(taskId)}/events`, relayUrl),
    { headers: { accept: "text/event-stream" } },
  );
  if (!response.ok || !response.body) {
    await responseJson(response);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) {
          const event = JSON.parse(line.slice(6));
          onEvent(event);
          if (TERMINAL_TASK_STATUSES.has(event.status)) {
            await reader.cancel();
            return event;
          }
        }
      }
    }
    if (done) {
      return null;
    }
  }
}

export async function submitTask(
  { relayUrl, hostId, conversationId, project, prompt, wait = true },
  { fetchImpl = fetch, onEvent = () => {} } = {},
) {
  const response = await fetchImpl(new URL("/v1/tasks", relayUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId, conversationId, project, prompt }),
  });
  const { task } = await responseJson(response);
  onEvent(task);
  if (!wait || TERMINAL_TASK_STATUSES.has(task.status)) {
    return task;
  }
  return (await watchTask(relayUrl, task.id, onEvent, fetchImpl)) ?? task;
}

async function waitForShutdown(close) {
  await new Promise((resolvePromise) => {
    const finish = () => resolvePromise();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  await close();
}

export async function main(arguments_ = process.argv.slice(2)) {
  const parsed = parseArguments(arguments_);
  if (parsed.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (parsed.command === "project-add") {
    const store = new HostStore(PATHS.hostDatabase);
    try {
      requireIdentifier(parsed.alias, "project alias");
      const root = await resolveGitProjectRoot(resolve(parsed.path));
      const project = store.upsertProject({
        alias: parsed.alias,
        root,
        permissions: parsed.permissions,
      });
      process.stdout.write(
        `Registered project ${project.alias}\nRoot: ${project.root}\nPermissions: ${project.permissions}\n`,
      );
    } finally {
      store.close();
    }
    return;
  }

  if (parsed.command === "project-list") {
    const store = new HostStore(PATHS.hostDatabase);
    try {
      for (const project of store.listProjects()) {
        process.stdout.write(
          `${project.alias}\t${project.root}\t${project.permissions}\t${project.codexProjectId ?? "unresolved"}\n`,
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  if (parsed.command === "relay-run") {
    const store = new RelayStore(PATHS.relayDatabase);
    const relay = createRelay({ store, host: parsed.host, port: parsed.port });
    const address = await relay.start();
    process.stdout.write(`Synapse mock cloud listening at http://${address.host}:${address.port}\n`);
    await waitForShutdown(async () => {
      await relay.close();
      store.close();
    });
    return;
  }

  if (parsed.command === "host-run") {
    const store = new HostStore(PATHS.hostDatabase);
    const appServer = new AppServerClient({ codexBinary: CODEX_BINARY });
    const processor = new TaskProcessor({
      store,
      appServer,
      worktreeRoot: PATHS.worktreeRoot,
    });
    const connection = new HostConnection({
      processor,
      relayUrl: parsed.relayUrl,
      hostId: parsed.hostId,
    });
    await connection.start();
    process.stdout.write(
      `Synapse host ${parsed.hostId} connected to ${parsed.relayUrl}\n`,
    );
    await waitForShutdown(async () => {
      await connection.stop();
      store.close();
    });
    return;
  }

  if (parsed.command === "status") {
    const response = await fetch(
      new URL(`/v1/tasks/${encodeURIComponent(parsed.taskId)}`, parsed.relayUrl),
    );
    const { task } = await responseJson(response);
    process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    return;
  }

  if (parsed.command === "send") {
    let lastStatus = null;
    const result = await submitTask(parsed, {
      onEvent(event) {
        if (event.status !== lastStatus) {
          process.stdout.write(`[synapse] ${event.id}: ${event.status}\n`);
          lastStatus = event.status;
        }
      },
    });
    process.stdout.write(
      [
        "",
        `${TERMINAL_TASK_STATUSES.has(result.status) ? "Finished" : "Queued"}: ${result.id}`,
        `Conversation: ${result.conversationId}`,
        `Project: ${result.project}`,
        ...(result.threadId ? [`Thread: ${result.threadId}`] : []),
        ...(result.worktreePath ? [`Worktree: ${result.worktreePath}`] : []),
        ...(result.result ? [`Result: ${result.result}`] : []),
        ...(result.error ? [`Error: ${result.error}`] : []),
        "",
      ].join("\n"),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`Synapse failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
