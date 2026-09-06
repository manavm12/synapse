import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(arguments_, { cwd, execute = execFileAsync } = {}) {
  const { stdout } = await execute("git", arguments_, { cwd });
  return stdout.trim();
}

export function worktreeRoot(env = process.env) {
  return resolve(
    env.SYNAPSE_WORKTREE_ROOT ?? join(homedir(), ".synapse", "worktrees"),
  );
}

export function worktreePathForChannel(root, projectRoot, channelId) {
  const project = createHash("sha256")
    .update(projectRoot)
    .digest("hex")
    .slice(0, 12);
  const channel = createHash("sha256")
    .update(channelId)
    .digest("hex")
    .slice(0, 24);
  return join(root, project, channel);
}

async function gitPath(cwd, argument, execute) {
  const value = await runGit(["rev-parse", argument], { cwd, execute });
  return isAbsolute(value) ? value : resolve(cwd, value);
}

async function repositoriesMatch(projectRoot, child, execute) {
  const [projectCommon, childCommon] = await Promise.all([
    gitPath(projectRoot, "--git-common-dir", execute),
    gitPath(child, "--git-common-dir", execute),
  ]);
  return (await realpath(projectCommon)) === (await realpath(childCommon));
}

export async function ensureChannelWorktree(
  { projectRoot, channelId, root = worktreeRoot() },
  { execute = execFileAsync } = {},
) {
  const canonicalProject = await realpath(projectRoot);
  const path = worktreePathForChannel(root, canonicalProject, channelId);
  try {
    await access(join(path, ".git"));
    if (!(await repositoriesMatch(canonicalProject, path, execute))) {
      throw new Error(
        `Managed worktree belongs to another repository: ${path}`,
      );
    }
    return { path: await realpath(path), created: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const head = await runGit(["rev-parse", "HEAD"], {
    cwd: canonicalProject,
    execute,
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await runGit(["worktree", "add", "--detach", path, head], {
    cwd: canonicalProject,
    execute,
  });
  return { path: await realpath(path), created: true };
}
