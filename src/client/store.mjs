import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { acquireProcessLock, processIsRunning } from "./process-lock.mjs";

const EMPTY_STATE = Object.freeze({ version: 1, channels: {}, jobs: [] });
const SAFE_IDENTIFIER = /^[a-zA-Z0-9._:-]{1,128}$/;
const ACTIVE_CHANNEL_STATUSES = new Set([
  "routing",
  "dispatched",
  "claimed",
  "recovering",
  "blocked",
]);

function freshState() {
  return structuredClone(EMPTY_STATE);
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function mutateState(path, mutation) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const releaseLock = await acquireProcessLock(lockPath);
  try {
    const state = await readState(path);
    const result = await mutation(state);
    await releaseLock.assertOwned();
    await writeState(path, state);
    return result;
  } finally {
    await releaseLock();
  }
}

function publicMetadata(job) {
  return {
    jobId: job.id,
    channelId: job.channelId,
    sender: job.sender,
    status: job.status,
    ...(job.dispatchId ? { dispatchId: job.dispatchId } : {}),
  };
}

function requireIdentifier(value, label) {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function resetDispatch(job) {
  job.status = "pending";
  job.dispatchedAt = null;
  job.dispatchLeaseExpiresAt = null;
  job.dispatchId = null;
  job.claimedAt = null;
  job.workerPid = null;
  job.workerStartedAt = null;
  job.workerFinishedAt = null;
  job.threadId = null;
  job.turnId = null;
  job.recoveryId = null;
  job.recoveryStartedAt = null;
  job.recoveryLeaseExpiresAt = null;
}

function resetDesktopDelivery(job) {
  job.status = "pending";
  job.deliveryId = null;
  job.deliveryStartedAt = null;
  job.deliveryLeaseExpiresAt = null;
}

function recoverExpiredDesktopDeliveries(state, now) {
  for (const job of state.jobs) {
    if (
      job.status !== "routing" ||
      Date.parse(job.deliveryLeaseExpiresAt) > now
    ) {
      continue;
    }
    resetDesktopDelivery(job);
  }
}

function recoverExpiredUnownedDispatches(state, now) {
  for (const job of state.jobs) {
    if (!["dispatched", "claimed"].includes(job.status)) {
      continue;
    }
    if (job.workerPid) {
      continue;
    }
    if (Date.parse(job.dispatchLeaseExpiresAt) > now) {
      continue;
    }
    resetDispatch(job);
  }
}

function releaseExpiredDeadJobRecoveries(state, now) {
  for (const job of state.jobs) {
    if (
      job.status !== "recovering" ||
      Date.parse(job.recoveryLeaseExpiresAt) > now
    ) {
      continue;
    }
    // Keep the original dispatch and recorded turn so the next recovery owner
    // must still interrupt that turn before a replacement worker can start.
    job.status = "claimed";
    job.recoveryId = null;
    job.recoveryStartedAt = null;
    job.recoveryLeaseExpiresAt = null;
  }
}

export async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return freshState();
    }
    throw error;
  }
}

export async function resetState(path) {
  await writeState(path, freshState());
}

export async function addJob(
  path,
  { id, channelId, sender, task, projectRoot = null },
) {
  requireIdentifier(id, "job ID");
  requireIdentifier(channelId, "channel ID");
  requireIdentifier(sender, "sender");
  return mutateState(path, (state) => {
    if (state.jobs.some((job) => job.id === id)) {
      throw new Error(`Job already exists: ${id}`);
    }
    const channel = state.channels[channelId];
    if (channel?.projectRoot && projectRoot && channel.projectRoot !== projectRoot) {
      throw new Error(
        `Channel ${channelId} is attached to ${channel.projectRoot}, not ${projectRoot}`,
      );
    }
    state.channels[channelId] ??= {
      threadId: null,
      hostId: null,
      projectId: null,
      projectRoot,
      worktreePath: null,
    };
    state.channels[channelId].projectRoot ??= projectRoot;
    const job = {
      id,
      channelId,
      sender,
      task,
      projectRoot,
      status: "pending",
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      dispatchLeaseExpiresAt: null,
      dispatchId: null,
      claimedAt: null,
      completedAt: null,
      failedAt: null,
      result: null,
      error: null,
      workerPid: null,
      workerStartedAt: null,
      workerFinishedAt: null,
      threadId: null,
      turnId: null,
      recoveryId: null,
      recoveryStartedAt: null,
      recoveryLeaseExpiresAt: null,
      deliveryId: null,
      deliveryStartedAt: null,
      deliveryLeaseExpiresAt: null,
    };
    state.jobs.push(job);
    return publicMetadata(job);
  });
}

export async function reserveNextDesktopDelivery(
  path,
  {
    now = Date.now(),
    deliveryLeaseMs = 5 * 60_000,
    createDeliveryId = randomUUID,
    projectRoot = null,
  } = {},
) {
  return mutateState(path, (state) => {
    recoverExpiredDesktopDeliveries(state, now);
    const activeChannels = new Set(
      state.jobs
        .filter((candidate) => ACTIVE_CHANNEL_STATUSES.has(candidate.status))
        .map((candidate) => candidate.channelId),
    );
    const job = state.jobs.find(
      (candidate) =>
        candidate.status === "pending" &&
        !activeChannels.has(candidate.channelId) &&
        (!projectRoot || candidate.projectRoot === projectRoot),
    );
    if (!job) {
      return null;
    }
    job.status = "routing";
    job.deliveryId = createDeliveryId();
    job.deliveryStartedAt = new Date(now).toISOString();
    job.deliveryLeaseExpiresAt = new Date(now + deliveryLeaseMs).toISOString();
    const channel = structuredClone(state.channels[job.channelId]);
    // Threads created by the retired detached App Server have no native
    // project identity. Migrate the channel by creating one native task.
    if (!channel.projectId) {
      channel.threadId = null;
      channel.hostId = null;
    }
    return {
      jobId: job.id,
      channelId: job.channelId,
      sender: job.sender,
      task: job.task,
      deliveryId: job.deliveryId,
      projectRoot: job.projectRoot,
      channel,
    };
  });
}

export async function acknowledgeDesktopDelivery(
  path,
  jobId,
  deliveryId,
  { threadId, hostId, projectId },
) {
  requireIdentifier(threadId, "thread ID");
  requireIdentifier(hostId, "host ID");
  requireIdentifier(projectId, "project ID");
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    if (job.status !== "routing" || job.deliveryId !== deliveryId) {
      throw new Error(`Stale desktop delivery for job ${jobId}`);
    }
    const existing = state.channels[job.channelId] ?? {};
    state.channels[job.channelId] = {
      ...existing,
      threadId,
      hostId,
      projectId,
      projectRoot: job.projectRoot ?? existing.projectRoot ?? null,
      worktreePath: existing.worktreePath ?? null,
    };
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.workerFinishedAt = job.completedAt;
    job.threadId = threadId;
    job.result = "Delivered to the Codex project task";
    job.deliveryLeaseExpiresAt = null;
    return {
      ...publicMetadata(job),
      threadId,
      hostId,
      projectId,
    };
  });
}

export async function releaseDesktopDelivery(path, jobId, deliveryId) {
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job || job.status !== "routing" || job.deliveryId !== deliveryId) {
      return false;
    }
    resetDesktopDelivery(job);
    return true;
  });
}

export async function reserveNextJob(
  path,
  {
    now = Date.now(),
    unownedLeaseMs = 30_000,
    createDispatchId = randomUUID,
  } = {},
) {
  return mutateState(path, (state) => {
    recoverExpiredUnownedDispatches(state, now);
    const activeChannels = new Set(
      state.jobs
        .filter((candidate) => ACTIVE_CHANNEL_STATUSES.has(candidate.status))
        .map((candidate) => candidate.channelId),
    );
    const job = state.jobs.find(
      (candidate) =>
        candidate.status === "pending" && !activeChannels.has(candidate.channelId),
    );
    if (!job) {
      return null;
    }
    job.status = "dispatched";
    job.dispatchId = createDispatchId();
    job.dispatchedAt = new Date(now).toISOString();
    job.dispatchLeaseExpiresAt = new Date(now + unownedLeaseMs).toISOString();
    return publicMetadata(job);
  });
}

export async function releaseJob(path, jobId, dispatchId) {
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job || job.status !== "dispatched" || job.dispatchId !== dispatchId) {
      return false;
    }
    resetDispatch(job);
    return true;
  });
}

export async function claimTask(path, jobId, dispatchId, expectedChannelId = null) {
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    if (job.status !== "dispatched") {
      throw new Error(`Job ${jobId} cannot be claimed from status ${job.status}`);
    }
    if (job.dispatchId !== dispatchId) {
      throw new Error(`Stale dispatch attempt for job ${jobId}`);
    }
    if (expectedChannelId && job.channelId !== expectedChannelId) {
      throw new Error(`Job ${jobId} does not belong to channel ${expectedChannelId}`);
    }
    job.status = "claimed";
    job.claimedAt ??= new Date().toISOString();
    return {
      jobId: job.id,
      channelId: job.channelId,
      sender: job.sender,
      task: job.task,
    };
  });
}

export async function failTask(path, jobId, dispatchId, message) {
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    if (job.dispatchId !== dispatchId || !["dispatched", "claimed"].includes(job.status)) {
      return false;
    }
    job.status = "failed";
    job.failedAt = new Date().toISOString();
    job.error = message;
    return true;
  });
}

export async function getJob(path, jobId) {
  const state = await readState(path);
  return state.jobs.find((candidate) => candidate.id === jobId) ?? null;
}

export async function setJobWorker(path, jobId, dispatchId, pid) {
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job || !["dispatched", "claimed", "completed"].includes(job.status)) {
      throw new Error(`Job ${jobId} is not ready for a worker`);
    }
    if (job.dispatchId !== dispatchId) {
      throw new Error(`Stale dispatch attempt for job ${jobId}`);
    }
    job.workerPid = pid;
    job.workerStartedAt = new Date().toISOString();
    job.dispatchLeaseExpiresAt = null;
  });
}

export async function setJobTurn(path, jobId, dispatchId, { threadId, turnId }) {
  requireIdentifier(threadId, "thread ID");
  requireIdentifier(turnId, "turn ID");
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job || !["dispatched", "claimed", "completed"].includes(job.status)) {
      throw new Error(`Job ${jobId} is not ready for a turn`);
    }
    if (job.dispatchId !== dispatchId) {
      throw new Error(`Stale dispatch attempt for job ${jobId}`);
    }
    job.threadId = threadId;
    job.turnId = turnId;
  });
}

export async function reserveDeadJobRecovery(
  path,
  {
    now = Date.now(),
    recoveryLeaseMs = 30_000,
    createRecoveryId = randomUUID,
  } = {},
) {
  return mutateState(path, (state) => {
    releaseExpiredDeadJobRecoveries(state, now);
    for (const job of state.jobs) {
      if (!["dispatched", "claimed"].includes(job.status)) {
        continue;
      }
      if (!job.workerPid || processIsRunning(job.workerPid)) {
        continue;
      }
      if (!job.threadId || !job.turnId) {
        job.status = "blocked";
        job.failedAt = new Date().toISOString();
        job.error = "Worker exited before its Codex turn could be identified safely";
        job.workerFinishedAt ??= new Date().toISOString();
        continue;
      }
      job.status = "recovering";
      job.recoveryId = createRecoveryId();
      job.recoveryStartedAt = new Date(now).toISOString();
      job.recoveryLeaseExpiresAt = new Date(now + recoveryLeaseMs).toISOString();
      return {
        jobId: job.id,
        channelId: job.channelId,
        dispatchId: job.dispatchId,
        recoveryId: job.recoveryId,
        threadId: job.threadId,
        turnId: job.turnId,
      };
    }
    return null;
  });
}

export async function completeDeadJobRecovery(path, jobId, dispatchId, recoveryId) {
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (
      !job ||
      job.status !== "recovering" ||
      job.dispatchId !== dispatchId ||
      job.recoveryId !== recoveryId
    ) {
      return false;
    }
    resetDispatch(job);
    return true;
  });
}

export async function blockDeadJobRecovery(path, jobId, dispatchId, recoveryId, message) {
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (
      !job ||
      job.status !== "recovering" ||
      job.dispatchId !== dispatchId ||
      job.recoveryId !== recoveryId
    ) {
      return false;
    }
    job.status = "blocked";
    job.failedAt = new Date().toISOString();
    job.error = message;
    job.workerFinishedAt ??= new Date().toISOString();
    return true;
  });
}

export async function finishJobWorker(path, jobId, dispatchId) {
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    if (job.dispatchId !== dispatchId) {
      return false;
    }
    job.workerFinishedAt = new Date().toISOString();
    return true;
  });
}

export async function completeTask(
  path,
  jobId,
  dispatchId,
  result,
  expectedChannelId = null,
) {
  return mutateState(path, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    if (job.status !== "claimed") {
      throw new Error(`Job ${jobId} cannot complete from status ${job.status}`);
    }
    if (job.dispatchId !== dispatchId) {
      throw new Error(`Stale dispatch attempt for job ${jobId}`);
    }
    if (expectedChannelId && job.channelId !== expectedChannelId) {
      throw new Error(`Job ${jobId} does not belong to channel ${expectedChannelId}`);
    }
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.result = result;
    return publicMetadata(job);
  });
}

export async function getChannel(path, channelId) {
  const state = await readState(path);
  return state.channels[channelId] ?? null;
}

export async function setChannelThread(
  path,
  channelId,
  {
    threadId,
    worktreePath,
    hostId = null,
    projectId = null,
    projectRoot = null,
  },
) {
  return mutateState(path, (state) => {
    state.channels[channelId] = {
      threadId,
      hostId,
      projectId,
      projectRoot,
      worktreePath,
    };
    return structuredClone(state.channels[channelId]);
  });
}

export async function getPublicInbox(path) {
  const state = await readState(path);
  return state.jobs
    .filter((job) => job.status === "pending")
    .map((job) => publicMetadata(job));
}
