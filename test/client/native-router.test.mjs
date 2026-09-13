import assert from "node:assert/strict";
import test from "node:test";

import {
  routeDelivery,
  runReservedDelivery,
  selectProject,
} from "../../plugins/synapse/lib/native-router.mjs";

function toolResult(value, success = true) {
  return {
    success,
    contentItems: [
      {
        type: "inputText",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

test("a remote saved project with an identical path cannot capture local incoming work", () => {
  const remote = {
    path: "/project",
    projectId: "remote-project",
    hostId: "remote-host",
  };
  const local = {
    path: "/project",
    projectId: "local-project",
    hostId: "local",
  };
  assert.equal(selectProject([remote, local], "/project"), local);
  assert.throws(
    () => selectProject([remote], "/project"),
    /No saved Codex project/,
  );
});

function delivery(channel = {}) {
  return {
    jobId: "job-1",
    deliveryId: "delivery-1",
    channelId: "demo",
    projectRoot: "/project",
    nativePrompt:
      "do work\n\n<!-- synapse-delivery:v2 job=job-1 delivery=delivery-1 -->",
    channel: {
      threadId: null,
      hostId: null,
      projectId: null,
      ...channel,
    },
  };
}

class FakeClient {
  constructor(responses = {}) {
    this.responses = responses;
    this.calls = [];
    this.closed = false;
  }

  async start() {
    this.calls.push({ method: "start" });
  }

  async callTool(name, arguments_, metadata) {
    this.calls.push({
      method: "callTool",
      name,
      arguments: arguments_,
      metadata,
    });
    if (this.responses[name] instanceof Error) throw this.responses[name];
    if (typeof this.responses[name] === "function") {
      return this.responses[name](arguments_);
    }
    return (
      this.responses[name] ??
      {
        list_projects: toolResult({
          schemaVersion: 2,
          projects: [
            {
              projectId: "project-1",
              path: "/project",
              isGitRepository: true,
            },
          ],
        }),
        create_thread: toolResult({
          clientThreadId: "client-new-thread:1",
          hostId: "local",
        }),
        send_message_to_thread: toolResult("<codex_delegation />"),
      }[name]
    );
  }

  async close() {
    this.closed = true;
  }
}

test("project selection uses the desktop saved-project path", () => {
  const projects = [
    { projectId: "first", path: "/other" },
    { projectId: "real", path: "/project" },
  ];
  assert.equal(selectProject(projects, "/project").projectId, "real");
  assert.throws(() => selectProject(projects, "/missing"), /No saved/);
  assert.throws(
    () => selectProject([{ path: "/project" }], "/project"),
    /missing its ID/,
  );
});

test("Windows project selection accepts drive-letter case and long-path prefixes", () => {
  const project = {
    projectId: "windows-project",
    path: "c:\\Shobhit Goel\\Synapse\\synapse-core",
    hostId: "local",
  };
  assert.equal(
    selectProject([project], "C:\\Shobhit Goel\\Synapse\\synapse-core", {
      platform: "win32",
    }),
    project,
  );
  assert.equal(
    selectProject([project], "\\\\?\\C:\\Shobhit Goel\\Synapse\\synapse-core", {
      platform: "win32",
    }),
    project,
  );
  assert.throws(
    () =>
      selectProject([project], "C:\\Shobhit Goel\\Synapse\\other", {
        platform: "win32",
      }),
    /No saved Codex project/,
  );
});

test("new git tasks are accepted immediately from the temporary ID", async () => {
  const client = new FakeClient();
  const acceptances = [];
  const result = await routeDelivery(delivery(), {
    ownerThreadId: "owner-1",
    turnId: "turn-1",
    createClient: () => client,
    accept: (value) => {
      acceptances.push(value);
      return { status: "accepted" };
    },
  });
  assert.deepEqual(result, { status: "accepted" });
  assert.equal(client.closed, true);
  assert.deepEqual(acceptances, [
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      clientThreadId: "client-new-thread:1",
      projectId: "project-1",
      hostId: "local",
    },
  ]);
  const created = client.calls.find((call) => call.name === "create_thread");
  assert.equal(created.arguments.title, "Synapse: demo");
  assert.equal(created.arguments.prompt, delivery().nativePrompt);
  assert.deepEqual(created.arguments.target, {
    type: "project",
    projectId: "project-1",
    environment: {
      type: "worktree",
      startingState: { type: "working-tree" },
    },
  });
  assert.deepEqual(created.metadata, {
    threadId: "owner-1",
    turnId: "turn-1",
  });
});

test("an immediately permanent task is completed without reconciliation", async () => {
  const client = new FakeClient({
    create_thread: toolResult({ threadId: "thread-1", hostId: "local" }),
  });
  const acknowledgements = [];
  const result = await routeDelivery(delivery(), {
    ownerThreadId: "owner-1",
    createClient: () => client,
    acknowledge: (value) => {
      acknowledgements.push(value);
      return { status: "completed" };
    },
  });
  assert.deepEqual(result, { status: "completed" });
  assert.equal(acknowledgements[0].threadId, "thread-1");
});

test("existing channels are continued through the desktop task tool", async () => {
  const client = new FakeClient();
  const acknowledgements = [];
  await routeDelivery(
    delivery({
      threadId: "thread-1",
      hostId: "local",
      projectId: "project-1",
    }),
    {
      ownerThreadId: "owner-1",
      createClient: () => client,
      acknowledge: (value) => acknowledgements.push(value),
    },
  );
  const sent = client.calls.find(
    (call) => call.name === "send_message_to_thread",
  );
  assert.deepEqual(sent.arguments, {
    threadId: "thread-1",
    hostId: "local",
    prompt: delivery().nativePrompt,
  });
  assert.equal(
    client.calls.some((call) => call.name === "create_thread"),
    false,
  );
  assert.equal(acknowledgements[0].threadId, "thread-1");
});

test("a channel cannot silently switch desktop projects", async () => {
  const client = new FakeClient();
  await assert.rejects(
    routeDelivery(delivery({ projectId: "other-project" }), {
      ownerThreadId: "owner-1",
      createClient: () => client,
    }),
    /belongs to another Codex project/,
  );
  assert.equal(client.closed, true);
});

test("failed background routing is released for a later prompt", async () => {
  const retries = [];
  await assert.rejects(
    () =>
      runReservedDelivery(
        {
          jobId: "job-1",
          deliveryId: "delivery-1",
          ownerThreadId: "owner-1",
        },
        {
          load: () => delivery(),
          route: async () => {
            throw new Error("desktop pipe unavailable");
          },
          retry: (value) => retries.push(value),
        },
      ),
    /desktop pipe unavailable/,
  );
  assert.deepEqual(retries, [
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      error: "desktop pipe unavailable",
    },
  ]);
  assert.equal(
    await runReservedDelivery(
      { jobId: "missing", deliveryId: "missing" },
      { load: () => null },
    ),
    null,
  );
});
