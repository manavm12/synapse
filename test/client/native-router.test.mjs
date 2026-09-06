import assert from "node:assert/strict";
import test from "node:test";

import {
  routeDelivery,
  runReservedDelivery,
  selectProject,
  threadHasDeliveryMarker,
} from "../../plugins/synapse/lib/native-router.mjs";

function delivery(channel = {}) {
  return {
    jobId: "job-1",
    deliveryId: "delivery-1",
    channelId: "demo",
    projectRoot: "/project",
    nativePrompt:
      "do work\n\n<!-- synapse-delivery:v2 job=job-1 delivery=delivery-1 -->",
    dedupeMarkers: ["synapse-delivery:v2 job=job-1 delivery=delivery-1"],
    channel: {
      threadId: null,
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

  async request(method, params) {
    this.calls.push({ method, params });
    if (this.responses[method] instanceof Error) throw this.responses[method];
    if (typeof this.responses[method] === "function") {
      return this.responses[method](params);
    }
    return (
      this.responses[method] ??
      {
        "project/list": {
          data: [
            {
              id: "project-1",
              roots: [{ path: "/project" }],
              metadata: {},
            },
          ],
          nextCursor: null,
        },
        "thread/start": { thread: { id: "thread-1" } },
        "thread/name/set": {},
        "thread/read": { thread: { turns: [] } },
        "thread/queue/list": { data: [], nextCursor: null },
        "thread/queue/add": {
          queuedSubmission: {
            id: "queued-1",
            clientUserMessageId: "synapse-delivery-1",
          },
        },
        "thread/queue/start": { turn: { id: "turn-1" } },
      }[method]
    );
  }

  async close() {
    this.closed = true;
  }
}

test("project selection rejects ambiguity from compatibility probes", () => {
  const projects = [
    {
      id: "probe",
      roots: [{ path: "/project" }],
      metadata: { createdBy: "synapse-compatibility-probe" },
    },
    { id: "real", roots: [{ path: "/project" }], metadata: {} },
  ];
  assert.equal(selectProject(projects, "/project").id, "real");
  assert.throws(() => selectProject(projects, "/missing"), /No saved/);
});

test("only user messages count as delivered markers", () => {
  const marker = "synapse-delivery:v2 job=job-1 delivery=delivery-1";
  assert.equal(
    threadHasDeliveryMarker(
      {
        thread: {
          turns: [{ items: [{ type: "userMessage", content: marker }] }],
        },
      },
      [marker],
    ),
    true,
  );
  assert.equal(
    threadHasDeliveryMarker(
      {
        thread: {
          turns: [{ items: [{ type: "agentMessage", text: marker }] }],
        },
      },
      [marker],
    ),
    false,
  );
});

test("a new task is project-linked, named, queued, and acknowledged", async () => {
  const client = new FakeClient();
  const bindings = [];
  const acknowledgements = [];
  const result = await routeDelivery(delivery(), {
    createClient: () => client,
    createWorktree: async () => ({ path: "/worktree" }),
    bindThread: (value) => bindings.push(value),
    acknowledge: (value) => {
      acknowledgements.push(value);
      return { status: "completed" };
    },
  });
  assert.deepEqual(result, { status: "completed" });
  assert.equal(client.closed, true);
  assert.deepEqual(bindings[0], {
    jobId: "job-1",
    deliveryId: "delivery-1",
    threadId: "thread-1",
    projectId: "project-1",
    hostId: "local",
  });
  assert.equal(acknowledgements[0].threadId, "thread-1");
  const started = client.calls.find((call) => call.method === "thread/start");
  assert.equal(started.params.cwd, "/worktree");
  assert.equal(started.params.projectId, "project-1");
  const named = client.calls.find((call) => call.method === "thread/name/set");
  assert.equal(named.params.name, "Synapse: demo");
});

test("a delivered marker completes without queuing a duplicate", async () => {
  const client = new FakeClient({
    "thread/read": {
      thread: {
        turns: [
          {
            items: [
              {
                type: "userMessage",
                content: "synapse-delivery:v2 job=job-1 delivery=delivery-1",
              },
            ],
          },
        ],
      },
    },
  });
  await routeDelivery(
    delivery({ threadId: "thread-1", projectId: "project-1" }),
    {
      createClient: () => client,
      acknowledge: () => ({ status: "completed" }),
    },
  );
  assert.equal(
    client.calls.some((call) => call.method === "thread/queue/add"),
    false,
  );
});

test("a previously queued delivery is accepted without being added twice", async () => {
  const client = new FakeClient({
    "thread/queue/list": {
      data: [
        {
          id: "queued-existing",
          clientUserMessageId: "synapse-delivery-1",
        },
      ],
      nextCursor: null,
    },
  });
  await routeDelivery(
    delivery({ threadId: "thread-1", projectId: "project-1" }),
    {
      createClient: () => client,
      acknowledge: () => ({ status: "completed" }),
    },
  );
  assert.equal(
    client.calls.some((call) => call.method === "thread/queue/add"),
    false,
  );
  assert.equal(
    client.calls.some((call) => call.method === "thread/queue/start"),
    false,
  );
});

test("failed background routing is released for a later prompt", async () => {
  const retries = [];
  await assert.rejects(
    () =>
      runReservedDelivery(
        { jobId: "job-1", deliveryId: "delivery-1" },
        {
          load: () => delivery(),
          route: async () => {
            throw new Error("daemon unavailable");
          },
          retry: (value) => retries.push(value),
        },
      ),
    /daemon unavailable/,
  );
  assert.deepEqual(retries, [
    {
      jobId: "job-1",
      deliveryId: "delivery-1",
      error: "daemon unavailable",
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
