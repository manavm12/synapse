import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  CODEX_BINARY,
  RUNTIME_ROOT,
  STATE_PATH,
} from "./config.mjs";
import { acquireProcessLock, processIsRunning } from "./process-lock.mjs";
import { readState } from "./store.mjs";

const execFileAsync = promisify(execFile);

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serverPaths(runtimeRoot = RUNTIME_ROOT) {
  return {
    pidPath: join(runtimeRoot, "codex-app-server.pid"),
    socketPath: join(runtimeRoot, "codex-app-server.sock"),
    lifecycleLockPath: join(runtimeRoot, "codex-app-server.lifecycle.lock"),
  };
}

async function readServerRecord(pidPath) {
  try {
    const parsed = JSON.parse(await readFile(pidPath, "utf8"));
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 || !parsed.startMarker) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function processStartMarker(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function recordOwnsProcess(record, {
  isRunning = processIsRunning,
  getProcessStartMarker = processStartMarker,
} = {}) {
  if (!record || !isRunning(record.pid)) {
    return false;
  }
  return (await getProcessStartMarker(record.pid)) === record.startMarker;
}

async function serverIsRunning(pidPath, socketPath, options = {}) {
  const record = await readServerRecord(pidPath);
  if (!(await recordOwnsProcess(record, options))) {
    return false;
  }
  try {
    return (await stat(socketPath)).isSocket();
  } catch {
    return false;
  }
}

async function removeServerPaths({ pidPath, socketPath }) {
  await unlink(pidPath).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await unlink(socketPath).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

async function stopChildAfterFailedStartup(child, wait = sleep) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await wait(50);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await wait(50);
  }
  throw new Error(`Failed to stop App Server process ${child.pid} after startup failure`);
}

export function hasOtherLiveWorkers(
  state,
  { jobId, dispatchId },
  isRunning = processIsRunning,
) {
  return state.jobs.some(
    (job) =>
      !(job.id === jobId && job.dispatchId === dispatchId) &&
      (job.status === "recovering" ||
        (job.workerPid && !job.workerFinishedAt && isRunning(job.workerPid))),
  );
}

export async function ensureSharedAppServer(
  {
    runtimeRoot = RUNTIME_ROOT,
    codexBinary = CODEX_BINARY,
    attempts = 100,
    delayMs = 50,
  } = {},
  {
    spawnProcess = spawn,
    getProcessStartMarker = processStartMarker,
    wait = sleep,
  } = {},
) {
  const { pidPath, socketPath, lifecycleLockPath } = serverPaths(runtimeRoot);

  await mkdir(dirname(socketPath), { recursive: true });
  const releaseLock = await acquireProcessLock(lifecycleLockPath, {
    attempts: 200,
    delayMs: 50,
  });
  try {
    if (await serverIsRunning(pidPath, socketPath, { getProcessStartMarker })) {
      return socketPath;
    }
    await releaseLock.assertOwned();
    await unlink(socketPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });

    const log = openSync(join(runtimeRoot, "codex-app-server.log"), "a");
    const child = spawnProcess(
      codexBinary,
      ["app-server", "--listen", `unix://${socketPath}`],
      { detached: true, stdio: ["ignore", log, log] },
    );
    try {
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } finally {
      closeSync(log);
    }
    const startMarker = await getProcessStartMarker(child.pid);
    if (!startMarker) {
      await stopChildAfterFailedStartup(child, wait);
      await removeServerPaths({ pidPath, socketPath });
      throw new Error(`Could not determine App Server process identity for ${child.pid}`);
    }
    await writeFile(pidPath, `${JSON.stringify({ pid: child.pid, startMarker })}\n`, "utf8");

    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          if ((await stat(socketPath)).isSocket()) {
            child.unref();
            return socketPath;
          }
        } catch {
          // The socket appears after App Server startup completes.
        }
        await wait(delayMs);
      }
      throw new Error(`Shared Codex App Server did not start at ${socketPath}`);
    } catch (error) {
      await stopChildAfterFailedStartup(child, wait);
      await removeServerPaths({ pidPath, socketPath });
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

export async function stopSharedAppServerIfIdle(
  {
    statePath = STATE_PATH,
    runtimeRoot = RUNTIME_ROOT,
    jobId,
    dispatchId,
  },
  {
    readCurrentState = readState,
    isRunning = processIsRunning,
    getProcessStartMarker = processStartMarker,
    terminate = (pid) => process.kill(pid, "SIGTERM"),
    wait = sleep,
  } = {},
) {
  const { pidPath, socketPath, lifecycleLockPath } = serverPaths(runtimeRoot);
  await mkdir(runtimeRoot, { recursive: true });
  const releaseLock = await acquireProcessLock(lifecycleLockPath, {
    attempts: 200,
    delayMs: 50,
  });
  try {
    const state = await readCurrentState(statePath);
    if (hasOtherLiveWorkers(state, { jobId, dispatchId }, isRunning)) {
      return false;
    }

    const record = await readServerRecord(pidPath);
    if (!record || !isRunning(record.pid)) {
      await removeServerPaths({ pidPath, socketPath });
      return false;
    }
    if (!(await recordOwnsProcess(record, { isRunning, getProcessStartMarker }))) {
      await unlink(pidPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      return false;
    }

    terminate(record.pid);
    for (let attempt = 0; attempt < 100 && isRunning(record.pid); attempt += 1) {
      await wait(50);
    }
    if (isRunning(record.pid)) {
      throw new Error(`Codex App Server ${record.pid} did not stop`);
    }
    await removeServerPaths({ pidPath, socketPath });
    return true;
  } finally {
    await releaseLock();
  }
}
