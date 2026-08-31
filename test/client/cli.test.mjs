import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArguments,
  nextDispatcherDelivery,
  resolveProjectRoot,
  sendTask,
} from "../../src/client/cli.mjs";
import { DISPATCHER_PROMPT } from "../../src/client/dispatcher.mjs";

test("the CLI parses a channel and multi-word task", () => {
  assert.deepEqual(
    parseArguments(["send", "person-a--person-b", "create", "a", "file"]),
    {
      command: "send",
      channelId: "person-a--person-b",
      task: "create a file",
    },
  );
});

test("the CLI attaches a message to a named project", () => {
  assert.deepEqual(
    parseArguments([
      "send",
      "person-a--person-b",
      "--project",
      "synapse",
      "create",
      "a",
      "file",
    ]),
    {
      command: "send",
      channelId: "person-a--person-b",
      task: "create a file",
      project: "synapse",
    },
  );
  assert.equal(
    resolveProjectRoot("synapse", "/Users/example/synapse"),
    "/Users/example/synapse",
  );
});

test("the CLI parses the internal native-delivery acknowledgement", () => {
  assert.deepEqual(
    parseArguments([
      "acknowledge",
      "job-1",
      "delivery-1",
      "thread-1",
      "local",
      "project-1",
    ]),
    {
      command: "acknowledge",
      jobId: "job-1",
      deliveryId: "delivery-1",
      threadId: "thread-1",
      hostId: "local",
      projectId: "project-1",
    },
  );
});

test("the CLI exposes the exact scheduled dispatcher prompt", () => {
  assert.deepEqual(parseArguments(["dispatcher-prompt"]), {
    command: "dispatcher-prompt",
  });
  assert.match(DISPATCHER_PROMPT, /automatic Synapse dispatcher cycle/);
  assert.match(DISPATCHER_PROMPT, /route-inbox\/SKILL\.md/);
});

test("the CLI leases one delivery for the scheduled dispatcher", async () => {
  let receivedOptions = null;
  const payload = { jobId: "job-1", task: "do the thing" };

  const result = await nextDispatcherDelivery(
    { projectRoot: "/tmp/example-project" },
    {
      statePath: "/tmp/test-state.json",
      reserveDelivery: async (_path, options) => {
        receivedOptions = options;
        return payload;
      },
    },
  );

  assert.deepEqual(receivedOptions, { projectRoot: "/tmp/example-project" });
  assert.deepEqual(result, { status: "delivery", payload });
});

test("the CLI reports an empty scheduled dispatcher cycle", async () => {
  const result = await nextDispatcherDelivery(
    { projectRoot: "/tmp/example-project" },
    { reserveDelivery: async () => null },
  );

  assert.deepEqual(result, { status: "empty" });
});

test("send queues a task without starting a detached Codex writer", async () => {
  let storedJob = null;

  const summary = await sendTask(
    {
      channelId: "person-a--person-b",
      sender: "person-a",
      task: "create a proof file",
      projectRoot: "/tmp/example-project",
    },
    {
      statePath: "/tmp/test-state.json",
      createJobId: () => "manual-1",
      addJob: async (_path, job) => {
        storedJob = job;
        return {
          jobId: job.id,
          channelId: job.channelId,
          sender: job.sender,
          status: "pending",
        };
      },
    },
  );

  assert.equal(storedJob.task, "create a proof file");
  assert.equal(storedJob.projectRoot, "/tmp/example-project");
  assert.deepEqual(summary, {
    jobId: "manual-1",
    channelId: "person-a--person-b",
    sender: "person-a",
    status: "pending",
    delivery: "codex-project",
  });
});
