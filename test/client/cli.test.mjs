import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, sendMessage } from "../../src/client/cli.mjs";

test("send requires a channel, project, and exact task", () => {
  assert.deepEqual(
    parseArguments(["send", "demo", "--project", "synapse", "create", "a", "file"]),
    {
      command: "send",
      channelId: "demo",
      project: "synapse",
      task: "create a file",
    },
  );
});

test("send queues a message without starting Codex", async () => {
  let queued;
  const result = await sendMessage(
    {
      channelId: "demo",
      project: "synapse",
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
  assert.equal(queued.projectRoot, process.cwd());
  assert.equal(result.status, "pending");
});
