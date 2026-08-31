import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { PROJECT_ROOT, STATE_PATH } from "./config.mjs";
import { DISPATCHER_PROMPT } from "./dispatcher.mjs";
import {
  acknowledgeDesktopDelivery,
  addJob as addStoredJob,
  reserveNextDesktopDelivery,
} from "./store.mjs";

function usage() {
  return [
    "Usage:",
    '  npm run synapse -- send <channel-id> "<task>"',
    '  npm run synapse -- send <channel-id> --project <name-or-path> "<task>"',
    "  npm run synapse -- dispatcher-prompt",
    "  npm run synapse -- dispatcher-next",
    "  npm run synapse -- acknowledge <job-id> <delivery-id> <thread-id> <host-id> <project-id>",
    "",
    "send queues the message for a Synapse-enabled Codex project task.",
    "The same channel ID reuses its native Codex task and worktree.",
  ].join("\n");
}

export function parseArguments(arguments_) {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    return { command: "help" };
  }
  if (arguments_[0] === "dispatcher-prompt") {
    if (arguments_.length !== 1) {
      throw new Error(usage());
    }
    return { command: "dispatcher-prompt" };
  }
  if (arguments_[0] === "dispatcher-next") {
    if (arguments_.length !== 1) {
      throw new Error(usage());
    }
    return { command: "dispatcher-next" };
  }
  if (arguments_[0] === "acknowledge") {
    const [command, jobId, deliveryId, threadId, hostId, projectId, ...extra] =
      arguments_;
    if (
      extra.length > 0 ||
      !jobId ||
      !deliveryId ||
      !threadId ||
      !hostId ||
      !projectId
    ) {
      throw new Error(usage());
    }
    return { command, jobId, deliveryId, threadId, hostId, projectId };
  }
  const sendArguments = [...arguments_];
  const projectFlagIndex = sendArguments.indexOf("--project");
  let project = null;
  if (projectFlagIndex !== -1) {
    project = sendArguments[projectFlagIndex + 1];
    if (!project) {
      throw new Error(usage());
    }
    sendArguments.splice(projectFlagIndex, 2);
  }
  const [command, channelId, ...taskParts] = sendArguments;
  const task = taskParts.join(" ").trim();
  if (command !== "send" || !channelId || !task) {
    throw new Error(usage());
  }
  return { command, channelId, task, ...(project ? { project } : {}) };
}

export function resolveProjectRoot(project, cwd = process.cwd()) {
  const resolvedCwd = resolve(cwd);
  if (!project || project === basename(resolvedCwd)) {
    return resolvedCwd;
  }
  return resolve(resolvedCwd, project);
}

export async function sendTask(
  { channelId, task, sender = "local-user", projectRoot = PROJECT_ROOT },
  {
    statePath = STATE_PATH,
    createJobId = () => `manual-${Date.now()}-${randomUUID().slice(0, 8)}`,
    addJob = addStoredJob,
  } = {},
) {
  const jobId = createJobId();
  const metadata = await addJob(statePath, {
    id: jobId,
    channelId,
    sender,
    task,
    projectRoot,
  });
  return { ...metadata, delivery: "codex-project" };
}

export async function nextDispatcherDelivery(
  { projectRoot = PROJECT_ROOT } = {},
  {
    statePath = STATE_PATH,
    reserveDelivery = reserveNextDesktopDelivery,
  } = {},
) {
  const payload = await reserveDelivery(statePath, { projectRoot });
  return payload ? { status: "delivery", payload } : { status: "empty" };
}

export async function main(arguments_ = process.argv.slice(2)) {
  const parsed = parseArguments(arguments_);
  if (parsed.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.command === "dispatcher-prompt") {
    process.stdout.write(`${DISPATCHER_PROMPT}\n`);
    return;
  }
  if (parsed.command === "dispatcher-next") {
    const result = await nextDispatcherDelivery();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (parsed.command === "acknowledge") {
    const summary = await acknowledgeDesktopDelivery(
      STATE_PATH,
      parsed.jobId,
      parsed.deliveryId,
      {
        threadId: parsed.threadId,
        hostId: parsed.hostId,
        projectId: parsed.projectId,
      },
    );
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  const summary = await sendTask({
    channelId: parsed.channelId,
    task: parsed.task,
    sender: process.env.SYNAPSE_SENDER ?? "local-user",
    projectRoot: resolveProjectRoot(parsed.project),
  });
  process.stdout.write(
    [
      "",
      `Queued: ${summary.jobId}`,
      `Channel: ${summary.channelId}`,
      `Project: ${resolveProjectRoot(parsed.project)}`,
      "Delivery: the automatic Synapse Dispatcher will route it on its next scheduled check.",
      "",
    ].join("\n"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`Synapse failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
