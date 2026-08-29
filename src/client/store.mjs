import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { acquireProcessLock, processIsRunning } from "./process-lock.mjs";

const EMPTY_STATE = Object.freeze({ version: 1, channels: {}, jobs: [] });
const SAFE_IDENTIFIER = /^[a-zA-Z0-9._:-]{1,128}$/;

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
}

function recoverDeadWorkers(state, now) {
  for (const job of state.jobs) {
    if (!["dispatched", "claimed"].includes(job.status)) {
      continue;
    }
    if (job.workerPid && processIsRunning(job.workerPid)) {
      continue;
    }
    if (!job.workerPid && Date.parse(job.dispatchLeaseExpiresAt) > now) {
      continue;
    }
    resetDispatch(job);
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

export async function addJob(path, { id, channelId, sender, task }) {
  requireIdentifier(id, "job ID");
  requireIdentifier(channelId, "channel ID");
  requireIdentifier(sender, "sender");
  return mutateState(path, (state) => {
    if (state.jobs.some((job) => job.id === id)) {
      throw new Error(`Job already exists: ${id}`);
    }
    state.channels[channelId] ??= { threadId: null, worktreePath: null };
    const job = {
      id,
      channelId,
      sender,
      task,
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
    };
    state.jobs.push(job);
    return publicMetadata(job);
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
    recoverDeadWorkers(state, now);
    const activeChannels = new Set(
      state.jobs
        .filter((candidate) => ["dispatched", "claimed"].includes(candidate.status))
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

export async function claimTask(path, jobId, dispatchId) {
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

export async function completeTask(path, jobId, dispatchId, result) {
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

export async function setChannelThread(path, channelId, { threadId, worktreePath }) {
  return mutateState(path, (state) => {
    state.channels[channelId] = { threadId, worktreePath };
    return structuredClone(state.channels[channelId]);
  });
}

export async function getPublicInbox(path) {
  const state = await readState(path);
  return state.jobs
    .filter((job) => job.status === "pending")
    .map((job) => publicMetadata(job));
}
