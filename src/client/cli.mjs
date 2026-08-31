import { randomUUID } from "node:crypto";

import { STATE_PATH } from "./config.mjs";
import { dispatchInbox } from "./dispatch.mjs";
import { interruptTurnForRecovery } from "./recovery.mjs";
import {
  addJob as addStoredJob,
  getChannel as getStoredChannel,
  getJob as getStoredJob,
} from "./store.mjs";
import { spawnDetachedWorker } from "./worker-process.mjs";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_MS = 1_000;

function usage() {
  return [
    "Usage:",
    '  npm run synapse -- send <channel-id> "<task>"',
    "",
    "The same channel ID reuses its existing Codex thread and Git worktree.",
  ].join("\n");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseArguments(arguments_) {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    return { command: "help" };
  }
  const [command, channelId, ...taskParts] = arguments_;
  const task = taskParts.join(" ").trim();
  if (command !== "send" || !channelId || !task) {
    throw new Error(usage());
  }
  return { command, channelId, task };
}

export async function sendTask(
  { channelId, task, sender = "local-user" },
  {
    statePath = STATE_PATH,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
    createJobId = () => `manual-${Date.now()}-${randomUUID().slice(0, 8)}`,
    addJob = addStoredJob,
    getJob = getStoredJob,
    getChannel = getStoredChannel,
    dispatch = (path) =>
      dispatchInbox({
        statePath: path,
        spawnWorker: spawnDetachedWorker,
        recoverWorker: interruptTurnForRecovery,
      }),
    wait = sleep,
    now = Date.now,
    onStatus = ({ jobId, status }) =>
      process.stderr.write(`[synapse] ${jobId}: ${status}\n`),
  } = {},
) {
  const jobId = createJobId();
  await addJob(statePath, { id: jobId, channelId, sender, task });
  const deadline = now() + timeoutMs;
  let previousStatus = null;

  while (now() <= deadline) {
    const job = await getJob(statePath, jobId);
    if (!job) {
      throw new Error(`Synapse job disappeared: ${jobId}`);
    }
    if (job.status !== previousStatus) {
      onStatus({ jobId, status: job.status });
      previousStatus = job.status;
    }
    if (job.status === "completed") {
      const channel = await getChannel(statePath, channelId);
      return {
        jobId,
        channelId,
        status: job.status,
        threadId: channel?.threadId ?? null,
        worktreePath: channel?.worktreePath ?? null,
        result: job.result,
      };
    }
    if (["failed", "blocked"].includes(job.status)) {
      throw new Error(`Synapse job ${jobId} ${job.status}: ${job.error}`);
    }
    if (job.status === "pending") {
      await dispatch(statePath);
    }
    await wait(pollIntervalMs);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Synapse job ${jobId}; the detached worker may still be running`,
  );
}

export async function main(arguments_ = process.argv.slice(2)) {
  const parsed = parseArguments(arguments_);
  if (parsed.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const summary = await sendTask({
    channelId: parsed.channelId,
    task: parsed.task,
    sender: process.env.SYNAPSE_SENDER ?? "local-user",
  });
  process.stdout.write(
    [
      "",
      `Completed: ${summary.jobId}`,
      `Thread: ${summary.threadId}`,
      `Worktree: ${summary.worktreePath}`,
      `Result: ${summary.result}`,
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
