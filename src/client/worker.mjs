import { APP_SERVER_SOCKET, MCP_SERVER_PATH, STATE_PATH } from "./config.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import {
  ensureSharedAppServer,
  stopSharedAppServerIfIdle,
} from "./shared-app-server.mjs";
import {
  failTask,
  finishJobWorker,
  getChannel,
  getJob,
  setJobTurn,
  setJobWorker,
  setChannelThread,
} from "./store.mjs";
import { ensureWorktree } from "./worktree.mjs";

export const SYNAPSE_DEVELOPER_INSTRUCTIONS = [
  "This Codex task is being executed through Synapse.",
  "Before doing any work, call the synapse_local claim_task tool with no arguments to claim the current assignment.",
  "The user message contains the complete task to perform in the current worktree.",
  "After completing the task, call synapse_local complete_task with a concise result.",
  "Do not ask the user for confirmation unless the task itself genuinely requires a user decision.",
].join(" ");

export function taskTurnInput(task) {
  if (typeof task !== "string" || !task.trim()) {
    throw new Error("Synapse task must be a non-empty string");
  }
  return [
    {
      type: "text",
      text: task,
      text_elements: [],
    },
  ];
}

export async function runWorker({ jobId, channelId, dispatchId }) {
  const worktreePath = await ensureWorktree(channelId);
  const channel = await getChannel(STATE_PATH, channelId);
  const job = await getJob(STATE_PATH, jobId);
  if (
    !job ||
    job.channelId !== channelId ||
    job.dispatchId !== dispatchId ||
    !["dispatched", "claimed"].includes(job.status)
  ) {
    throw new Error(`Worker assignment is stale or invalid for ${jobId}`);
  }
  await ensureSharedAppServer();
  const client = new AppServerClient({ socketPath: APP_SERVER_SOCKET });
  let threadId = null;

  try {
    await client.start();
    const config = {
      features: { codex_hooks: false },
      mcp_servers: {
        synapse_local: {
          command: process.execPath,
          args: [MCP_SERVER_PATH],
          env: {
            SYNAPSE_STATE_PATH: STATE_PATH,
            SYNAPSE_JOB_ID: jobId,
            SYNAPSE_CHANNEL_ID: channelId,
            SYNAPSE_DISPATCH_ID: dispatchId,
          },
          required: true,
        },
      },
    };

    const threadResponse = channel?.threadId
      ? await client.request("thread/resume", {
          threadId: channel.threadId,
          cwd: worktreePath,
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: "workspace-write",
          config,
          developerInstructions: SYNAPSE_DEVELOPER_INSTRUCTIONS,
        })
      : await client.request("thread/start", {
          cwd: worktreePath,
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: "workspace-write",
          config,
          developerInstructions: SYNAPSE_DEVELOPER_INSTRUCTIONS,
          serviceName: "synapse-client",
          ephemeral: false,
        });

    threadId = threadResponse.thread.id;
    await setChannelThread(STATE_PATH, channelId, { threadId, worktreePath });
    if (!channel?.threadId) {
      await client.request("thread/name/set", {
        threadId,
        name: `Synapse: ${channelId}`,
      });
    }

    const completion = client.waitFor(
      "turn/completed",
      (params) => params.threadId === threadId,
    );
    const turnResponse = await client.request("turn/start", {
      threadId,
      input: taskTurnInput(job.task),
    });
    await setJobTurn(STATE_PATH, jobId, dispatchId, {
      threadId,
      turnId: turnResponse.turn.id,
    });
    const completed = await completion;
    if (completed.turn.id !== turnResponse.turn.id || completed.turn.status !== "completed") {
      throw new Error(
        `Child turn ended unexpectedly: ${completed.turn.status} ${JSON.stringify(completed.turn.error)}`,
      );
    }
    return { threadId, turnId: completed.turn.id, worktreePath };
  } finally {
    if (threadId) {
      await client.request("thread/unsubscribe", { threadId }).catch((error) => {
        process.stderr.write(`Failed to unsubscribe ${threadId}: ${error.message}\n`);
      });
    }
    await client.close();
  }
}

export async function executeJob({
  jobId,
  channelId,
  dispatchId,
  statePath = STATE_PATH,
  run = runWorker,
  releaseServer = null,
}) {
  try {
    const result = await run({ jobId, channelId, dispatchId });
    const job = await getJob(statePath, jobId);
    if (job?.status !== "completed" || job.dispatchId !== dispatchId) {
      throw new Error(`Worker exited without completing ${jobId}`);
    }
    return result;
  } catch (error) {
    const job = await getJob(statePath, jobId);
    if (job?.status === "completed" && job.dispatchId === dispatchId) {
      return undefined;
    }
    await failTask(statePath, jobId, dispatchId, error.message);
    throw error;
  } finally {
    const release = releaseServer ?? (run === runWorker ? stopSharedAppServerIfIdle : null);
    if (release) {
      await release({ statePath, jobId, dispatchId }).catch((error) => {
        process.stderr.write(`Failed to release Codex App Server: ${error.message}\n`);
      });
    }
    await finishJobWorker(statePath, jobId, dispatchId);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [jobId, channelId, dispatchId] = process.argv.slice(2);
  if (!jobId || !channelId || !dispatchId) {
    throw new Error("Usage: node worker.mjs <job-id> <channel-id> <dispatch-id>");
  }
  await setJobWorker(STATE_PATH, jobId, dispatchId, process.pid);
  await executeJob({ jobId, channelId, dispatchId });
}
