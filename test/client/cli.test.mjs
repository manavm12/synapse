import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseArguments,
  resolveProjectRoot,
  sendMessage,
} from "../../src/client/cli.mjs";

const cliPath = resolve("src/client/cli.mjs");
const execFileAsync = promisify(execFile);

async function primaryGitCheckout() {
  const path = await mkdtemp(join(tmpdir(), "synapse-project-test-"));
  await execFileAsync("git", ["init", "--quiet", path]);
  return realpath(path);
}

function runCli(arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

test("send requires a channel, project, and exact task", () => {
  assert.deepEqual(
    parseArguments([
      "send",
      "demo",
      "--project",
      "synapse",
      "create",
      "a",
      "file",
    ]),
    {
      command: "send",
      channelId: "demo",
      project: "synapse",
      task: "create a file",
    },
  );
});

test("legacy recovery requires explicit owner-stopped confirmation", () => {
  assert.deepEqual(parseArguments(["recover", "job-1", "--owner-stopped"]), {
    command: "recover",
    jobId: "job-1",
  });
  assert.throws(() => parseArguments(["recover", "job-1"]), /Usage:/);
});

test("invalid commands fail without exposing a stack trace", async () => {
  const result = await runCli(["send", "demo"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Synapse failed: Usage:/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("help exits successfully", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage:/);
  assert.equal(result.stderr, "");
});

test("send queues a message without starting Codex", async () => {
  const projectRoot = await primaryGitCheckout();
  let queued;
  const result = await sendMessage(
    {
      channelId: "demo",
      project: projectRoot,
      task: "create a file",
      cwd: process.cwd(),
    },
    {
      createId: () => "job-1",
      queue: (message) => {
        queued = message;
        return { ...message, jobId: message.id, status: "pending" };
      },
    },
  );
  assert.equal(queued.task, "create a file");
  assert.equal(queued.projectRoot, projectRoot);
  assert.equal(result.status, "pending");
});

test("a linked-worktree project is rejected before enqueue", async () => {
  await assert.rejects(
    () =>
      resolveProjectRoot("/tmp/project-worktree", process.cwd(), {
        execGit: async () => ({
          stdout: [
            "/tmp/project-worktree",
            "/tmp/project/.git/worktrees/project-worktree",
            "/tmp/project/.git",
          ].join("\n"),
        }),
      }),
    /primary checkout, not a linked worktree/,
  );
});

test("a non-Git directory is rejected before enqueue", async () => {
  await assert.rejects(
    () =>
      resolveProjectRoot("/tmp/not-a-repository", process.cwd(), {
        execGit: async () => {
          throw new Error("not a repository");
        },
      }),
    /Project is not a Git checkout/,
  );
});
