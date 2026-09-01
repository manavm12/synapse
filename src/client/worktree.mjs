import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(arguments_, { cwd, execute = execFileAsync } = {}) {
  const { stdout } = await execute("git", arguments_, { cwd });
  return stdout.trim();
}

export function worktreePathForConversation(worktreeRoot, projectRoot, conversationId) {
  const projectHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  const conversationHash = createHash("sha256")
    .update(conversationId)
    .digest("hex")
    .slice(0, 24);
  return join(worktreeRoot, projectHash, conversationHash);
}

export async function resolveGitProjectRoot(path, options = {}) {
  const candidate = resolve(path);
  const root = await runGit(["rev-parse", "--show-toplevel"], {
    cwd: candidate,
    execute: options.execute,
  });
  return realpath(root);
}

export async function ensureWorktree({
  projectRoot,
  worktreeRoot,
  conversationId,
  execute = execFileAsync,
}) {
  const canonicalProjectRoot = await resolveGitProjectRoot(projectRoot, { execute });
  const path = worktreePathForConversation(
    worktreeRoot,
    canonicalProjectRoot,
    conversationId,
  );
  try {
    await access(join(path, ".git"));
    const head = await runGit(["rev-parse", "HEAD"], { cwd: path, execute });
    return { path, head, created: false, projectRoot: canonicalProjectRoot };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const head = await runGit(["rev-parse", "HEAD"], {
    cwd: canonicalProjectRoot,
    execute,
  });
  await mkdir(dirname(path), { recursive: true });
  await runGit(["worktree", "add", "--detach", path, head], {
    cwd: canonicalProjectRoot,
    execute,
  });
  return { path, head, created: true, projectRoot: canonicalProjectRoot };
}

export function assertManagedWorktreePath(worktreeRoot, path) {
  const managedRoot = resolve(worktreeRoot);
  const candidate = resolve(path);
  const child = relative(managedRoot, candidate);
  if (!child || child.startsWith("..") || child === "." || child.includes("../")) {
    throw new Error(`Refusing unmanaged worktree path: ${candidate}`);
  }
  return candidate;
}

export async function removeManagedWorktree({
  projectRoot,
  worktreeRoot,
  path,
  force = false,
  execute = execFileAsync,
}) {
  const candidate = assertManagedWorktreePath(worktreeRoot, path);
  const arguments_ = ["worktree", "remove"];
  if (force) {
    arguments_.push("--force");
  }
  arguments_.push(candidate);
  await runGit(arguments_, { cwd: projectRoot, execute });
}
