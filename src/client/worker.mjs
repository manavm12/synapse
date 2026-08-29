import { APP_SERVER_SOCKET, MCP_SERVER_PATH, STATE_PATH } from "./config.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import { ensureSharedAppServer } from "./shared-app-server.mjs";
import {
  failTask,
  finishJobWorker,
  getChannel,
  getJob,
  setJobWorker,
  setChannelThread,
} from "./store.mjs";
import { ensureWorktree } from "./worktree.mjs";

export async function runWorker({ jobId, channelId, dispatchId }) {
  const worktreePath = await ensureWorktree(channelId);
  const channel = await getChannel(STATE_PATH, channelId);
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
          env: { SYNAPSE_STATE_PATH: STATE_PATH },
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
        })
      : await client.request("thread/start", {
          cwd: worktreePath,
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: "workspace-write",
          config,
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
      input: [
        {
          type: "text",
          text: [
            `Handle Synapse job ${jobId} in channel ${channelId}.`,
            `First call the synapse_local claim_task tool with job ID ${jobId} and dispatch ID ${dispatchId}.`,
            "Complete the claimed task in the current worktree.",
            "Then call synapse_local complete_task with the same job ID, dispatch ID, and a concise result.",
            "Do not ask the user for confirmation.",
          ].join(" "),
          text_elements: [],
        },
      ],
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
