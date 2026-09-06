import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  main,
  parseArguments,
  resolveProjectRoot,
  sendMessage,
} from "../../src/client/cli.mjs";
import { connectProject } from "../../src/client/project-registry.mjs";

const execFileAsync = promisify(execFile);

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

test("help exits successfully through the CLI entrypoint", async (t) => {
  const writes = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });

  await main(["--help"]);

  assert.match(writes.join(""), /^Usage:/);
});

test("operator commands reject unknown options", () => {
  assert.deepEqual(
    parseArguments([
      "admin",
      "invite",
      "--email",
      "person@example.com",
      "--username",
      "person",
      "--project",
      "synapse",
    ]),
    {
      command: "admin-invite",
      email: "person@example.com",
      username: "person",
      projectAlias: "synapse",
    },
  );
  assert.throws(
    () =>
      parseArguments([
        "admin",
        "configure",
        "--mcp-url",
        "https://memory.example/mcp",
        "--unexpected",
        "value",
      ]),
    /Usage:/,
  );
});

test("project connect writes only alias and canonical root to the private host DB", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-connect-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  const result = await connectProject(
    { alias: "Synapse", project: root },
    {
      env: { SYNAPSE_HOME: join(directory, "state") },
      resolveRoot: async () => root,
    },
  );
  assert.equal(result.alias, "synapse");
  assert.equal(result.root, root);
  assert.equal(result.created, true);
  assert.equal(
    (
      await connectProject(
        { alias: "synapse", project: root },
        {
          env: { SYNAPSE_HOME: join(directory, "state") },
          resolveRoot: async () => root,
        },
      )
    ).created,
    false,
  );
});

test("send queues a message without starting Codex", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "synapse-cli-test-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q", projectRoot]);
  const canonicalProjectRoot = await realpath(projectRoot);
  let queued;
  const result = await sendMessage(
    {
      channelId: "demo",
      project: basename(projectRoot),
      task: "create a file",
      cwd: projectRoot,
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
  assert.equal(queued.projectRoot, canonicalProjectRoot);
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
