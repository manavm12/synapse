import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    if (error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function ownerPid(name) {
  const match = /^owner-(\d+)-/.exec(name);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function reclaimLegacyLock(path) {
  try {
    const [pidText] = (await readFile(path, "utf8")).trim().split(":");
    const pid = Number.parseInt(pidText, 10);
    if (Number.isInteger(pid) && processIsRunning(pid)) {
      return false;
    }
    await unlink(path);
    return true;
  } catch (error) {
    if (["EISDIR", "ENOENT"].includes(error.code)) {
      return error.code === "ENOENT";
    }
    throw error;
  }
}

async function reclaimDeadLock(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    if (error.code === "ENOTDIR") {
      return reclaimLegacyLock(path);
    }
    throw error;
  }

  const owners = entries.filter((entry) => entry.isFile() && ownerPid(entry.name));
  if (owners.some((entry) => processIsRunning(ownerPid(entry.name)))) {
    return false;
  }

  for (const owner of owners) {
    await unlink(join(path, owner.name)).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    if (["EEXIST", "ENOTEMPTY"].includes(error.code)) {
      return false;
    }
    throw error;
  }
}

export async function acquireProcessLock(path, { attempts = 100, delayMs = 10 } = {}) {
  const lockId = randomUUID();
  const ownerName = `owner-${process.pid}-${lockId}`;
  const temporaryPath = `${path}.${lockId}.tmp`;
  await mkdir(temporaryPath);
  await writeFile(join(temporaryPath, ownerName), "", "utf8");

  let acquired = false;
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await rename(temporaryPath, path);
        acquired = true;
        const ownerPath = join(path, ownerName);
        const assertOwned = async () => {
          try {
            await access(ownerPath);
          } catch {
            throw new Error(`Lost ownership of process lock: ${path}`);
          }
        };
        const release = async () => {
          await unlink(ownerPath).catch((error) => {
            if (!["ENOENT", "ENOTDIR"].includes(error.code)) {
              throw error;
            }
          });
          await rmdir(path).catch((error) => {
            if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) {
              throw error;
            }
          });
        };
        release.assertOwned = assertOwned;
        return release;
      } catch (error) {
        if (!["EEXIST", "ENOTDIR", "ENOTEMPTY"].includes(error.code)) {
          throw error;
        }
        if (!(await reclaimDeadLock(path))) {
          await sleep(delayMs);
        }
      }
    }
  } finally {
    if (!acquired) {
      await rm(temporaryPath, { recursive: true, force: true });
    }
  }

  throw new Error(`Timed out waiting for process lock: ${path}`);
}
