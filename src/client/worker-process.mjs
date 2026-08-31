import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { RUNTIME_ROOT, STATE_PATH, WORKER_PATH } from "./config.mjs";
import { setJobWorker } from "./store.mjs";

export async function spawnDetachedWorker(
  metadata,
  {
    runtimeRoot = RUNTIME_ROOT,
    statePath = STATE_PATH,
    workerPath = WORKER_PATH,
    nodePath = process.execPath,
    spawnProcess = spawn,
  } = {},
) {
  const logDirectory = join(runtimeRoot, "logs");
  await mkdir(logDirectory, { recursive: true });
  const logName = createHash("sha256")
    .update(`${metadata.jobId}:${metadata.dispatchId}`)
    .digest("hex");
  const output = openSync(join(logDirectory, `${logName}.log`), "a");
  const child = spawnProcess(
    nodePath,
    [workerPath, metadata.jobId, metadata.channelId, metadata.dispatchId],
    {
      detached: true,
      env: { ...process.env, SYNAPSE_STATE_PATH: statePath },
      stdio: ["ignore", output, output],
    },
  );
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    closeSync(output);
  }
  child.unref();
  try {
    await setJobWorker(statePath, metadata.jobId, metadata.dispatchId, child.pid);
  } catch (error) {
    process.kill(child.pid, "SIGTERM");
    throw error;
  }
}
