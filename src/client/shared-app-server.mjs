import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { APP_SERVER_SOCKET, CODEX_BINARY, RUNTIME_ROOT } from "./config.mjs";
import { acquireProcessLock } from "./process-lock.mjs";

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const PID_PATH = join(RUNTIME_ROOT, "codex-app-server.pid");
const START_LOCK_PATH = join(RUNTIME_ROOT, "codex-app-server.start.lock");

async function serverIsRunning() {
  try {
    const pid = Number.parseInt(await readFile(PID_PATH, "utf8"), 10);
    process.kill(pid, 0);
    return (await stat(APP_SERVER_SOCKET)).isSocket();
  } catch {
    return false;
  }
}

export async function ensureSharedAppServer() {
  if (await serverIsRunning()) {
    return APP_SERVER_SOCKET;
  }

  await mkdir(dirname(APP_SERVER_SOCKET), { recursive: true });
  const releaseLock = await acquireProcessLock(START_LOCK_PATH, {
    attempts: 200,
    delayMs: 50,
  });
  try {
    if (await serverIsRunning()) {
      return APP_SERVER_SOCKET;
    }
    await releaseLock.assertOwned();
    await unlink(APP_SERVER_SOCKET).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });

    const log = openSync(join(RUNTIME_ROOT, "codex-app-server.log"), "a");
    const child = spawn(
      CODEX_BINARY,
      ["app-server", "--listen", `unix://${APP_SERVER_SOCKET}`],
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
    await writeFile(PID_PATH, `${child.pid}\n`, "utf8");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await stat(APP_SERVER_SOCKET)).isSocket()) {
          return APP_SERVER_SOCKET;
        }
      } catch {
        // The socket appears after App Server startup completes.
      }
      await sleep(50);
    }
    throw new Error(`Shared Codex App Server did not start at ${APP_SERVER_SOCKET}`);
  } finally {
    await releaseLock();
  }
}
