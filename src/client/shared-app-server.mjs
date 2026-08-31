import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CODEX_BINARY,
  RUNTIME_ROOT,
  STATE_PATH,
} from "./config.mjs";
import { acquireProcessLock, processIsRunning } from "./process-lock.mjs";
import { readState } from "./store.mjs";

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

async function readServerPid(pidPath) {
  try {
    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function serverIsRunning(pidPath, socketPath) {
  const pid = await readServerPid(pidPath);
  if (!pid || !processIsRunning(pid)) {
    return false;
  }
  try {
    return (await stat(socketPath)).isSocket();
  } catch {
    return false;
  }
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

export async function ensureSharedAppServer({ runtimeRoot = RUNTIME_ROOT } = {}) {
  const { pidPath, socketPath, lifecycleLockPath } = serverPaths(runtimeRoot);

  await mkdir(dirname(socketPath), { recursive: true });
  const releaseLock = await acquireProcessLock(lifecycleLockPath, {
    attempts: 200,
    delayMs: 50,
  });
  try {
    if (await serverIsRunning(pidPath, socketPath)) {
      return socketPath;
    }
    await releaseLock.assertOwned();
    await unlink(socketPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });

    const log = openSync(join(runtimeRoot, "codex-app-server.log"), "a");
    const child = spawn(
      CODEX_BINARY,
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
    child.unref();
    await writeFile(pidPath, `${child.pid}\n`, "utf8");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await stat(socketPath)).isSocket()) {
          return socketPath;
        }
      } catch {
        // The socket appears after App Server startup completes.
      }
      await sleep(50);
    }
    throw new Error(`Shared Codex App Server did not start at ${socketPath}`);
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

    const pid = await readServerPid(pidPath);
    if (!pid || !isRunning(pid)) {
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
      return false;
    }

    terminate(pid);
    for (let attempt = 0; attempt < 100 && isRunning(pid); attempt += 1) {
      await wait(50);
    }
    if (isRunning(pid)) {
      throw new Error(`Codex App Server ${pid} did not stop`);
    }
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
    return true;
  } finally {
    await releaseLock();
  }
}
