import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertManagedWorktreePath,
  ensureWorktree,
  removeManagedWorktree,
  worktreePathForConversation,
} from "../../src/client/worktree.mjs";

const execFileAsync = promisify(execFile);

test("worktree paths are isolated by project and conversation", () => {
  assert.notEqual(
    worktreePathForConversation("/tmp/root", "/tmp/project-a", "conversation"),
    worktreePathForConversation("/tmp/root", "/tmp/project-b", "conversation"),
  );
  assert.notEqual(
    worktreePathForConversation("/tmp/root", "/tmp/project-a", "conversation/a"),
    worktreePathForConversation("/tmp/root", "/tmp/project-a", "conversation-a"),
  );
});

test("managed path validation rejects the worktree root and siblings", () => {
  assert.throws(() => assertManagedWorktreePath("/tmp/managed", "/tmp/managed"));
  assert.throws(() => assertManagedWorktreePath("/tmp/managed", "/tmp/other"));
  assert.equal(
    assertManagedWorktreePath("/tmp/managed", "/tmp/managed/project/channel"),
    "/tmp/managed/project/channel",
  );
});

test("worktrees start from committed HEAD and are reused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synapse-worktree-test-"));
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  await execFileAsync("git", ["init", repository]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Test"]);
  await writeFile(join(repository, "tracked.txt"), "tracked\n");
  await execFileAsync("git", ["-C", repository, "add", "tracked.txt"]);
  await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
  await writeFile(join(repository, "tracked.txt"), "dirty checkout\n");
  await writeFile(join(repository, "untracked.txt"), "not committed\n");
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await ensureWorktree({
    projectRoot: repository,
    worktreeRoot: worktrees,
    conversationId: "demo",
  });
  const second = await ensureWorktree({
    projectRoot: repository,
    worktreeRoot: worktrees,
    conversationId: "demo",
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.path, second.path);
  assert.equal(first.head, second.head);
  assert.equal(await readFile(join(first.path, "tracked.txt"), "utf8"), "tracked\n");
  await assert.rejects(access(join(first.path, "untracked.txt")), { code: "ENOENT" });

  await removeManagedWorktree({
    projectRoot: repository,
    worktreeRoot: worktrees,
    path: first.path,
    force: true,
  });
});
