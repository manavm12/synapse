import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { PROJECT_ROOT, RUNTIME_ROOT } from "./config.mjs";

const execFileAsync = promisify(execFile);

export function worktreePathForChannel(runtimeRoot, channelId) {
  const channelHash = createHash("sha256").update(channelId).digest("hex").slice(0, 24);
  return join(runtimeRoot, "worktrees", channelHash);
}

export async function ensureWorktree(channelId) {
  const path = worktreePathForChannel(RUNTIME_ROOT, channelId);
  try {
    await access(join(path, ".git"));
    return path;
  } catch {
    await mkdir(join(RUNTIME_ROOT, "worktrees"), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "--detach", path, "HEAD"], {
      cwd: PROJECT_ROOT,
    });
    return path;
  }
}
