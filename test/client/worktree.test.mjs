import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ensureChannelWorktree,
  worktreePathForChannel,
} from "../../plugins/synapse/lib/worktree.mjs";

const execFileAsync = promisify(execFile);

test("worktree paths are isolated by project and channel", () => {
  assert.notEqual(
    worktreePathForChannel("/tmp/root", "/tmp/project-a", "channel"),
    worktreePathForChannel("/tmp/root", "/tmp/project-b", "channel"),
  );
  assert.notEqual(
    worktreePathForChannel("/tmp/root", "/tmp/project", "channel/a"),
    worktreePathForChannel("/tmp/root", "/tmp/project", "channel-a"),
  );
});

test("worktrees start from committed HEAD and are reused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synapse-worktree-test-"));
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "test@example.com",
  ]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Test"]);
  await writeFile(join(repository, "tracked.txt"), "tracked\n");
  await execFileAsync("git", ["-C", repository, "add", "tracked.txt"]);
  await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
  await writeFile(join(repository, "tracked.txt"), "dirty\n");

  const first = await ensureChannelWorktree({
    projectRoot: repository,
    channelId: "demo",
    root: worktrees,
  });
  const second = await ensureChannelWorktree({
    projectRoot: repository,
    channelId: "demo",
    root: worktrees,
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.path, second.path);
  assert.equal(
    await readFile(join(first.path, "tracked.txt"), "utf8"),
    "tracked\n",
  );
});
