import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryProcessingRunner } from "../../src/server/memory-processing/runner.mjs";

const source = {
  version: 1,
  ownerId: "owner",
  projectId: "project",
  revisionId: "revision",
  nodeId: "node",
  sessionId: "session",
  revision: 1,
  captureId: "capture",
  title: "Title",
  summary: "Summary",
  markdown: "# Memory",
  capturedAt: "2026-09-07T00:00:00.000Z",
};

function createFakeStorage(overrides = {}) {
  return {
    async claimNext() {
      return {
        id: "job",
        projectId: "project",
        leaseToken: "token",
        leaseFence: 1,
        source,
      };
    },
    async renewLease() {},
    async complete(_job, commit) {
      await commit({ query: async () => ({ rowCount: 1 }) });
    },
    async fail() {},
    ...overrides,
  };
}

test("runner remains disabled without a production handler", async () => {
  let claimed = false;
  const storage = createFakeStorage({
    async claimNext() {
      claimed = true;
    },
  });
  const runner = createMemoryProcessingRunner({
    storage,
    workerId: "worker",
  });
  assert.equal(runner.enabled, false);
  assert.deepEqual(await runner.runOnce(), { status: "disabled" });
  assert.equal(claimed, false);
});

test("runner passes the immutable source and commits through storage", async () => {
  const events = [];
  const runner = createMemoryProcessingRunner({
    storage: createFakeStorage({
      async complete(job, commit) {
        events.push(["complete", job.id]);
        await commit("transaction-client");
      },
    }),
    handler: {
      async process(input) {
        events.push(["process", input]);
        return { mutations: ["deterministic-result"] };
      },
      async commit(input) {
        events.push(["commit", input]);
      },
    },
    workerId: "worker",
  });

  assert.deepEqual(await runner.runOnce(), {
    status: "succeeded",
    jobId: "job",
  });
  assert.deepEqual(events[0], ["process", source]);
  assert.deepEqual(events[1], ["complete", "job"]);
  assert.deepEqual(events[2], [
    "commit",
    {
      client: "transaction-client",
      source,
      result: { mutations: ["deterministic-result"] },
    },
  ]);
});

test("runner records handler failures for bounded storage retry", async () => {
  const expected = new Error("proposal rejected");
  let failedWith;
  const runner = createMemoryProcessingRunner({
    storage: createFakeStorage({
      async fail(job, error) {
        failedWith = [job.id, error];
      },
    }),
    handler: {
      async process() {
        throw expected;
      },
      async commit() {},
    },
    workerId: "worker",
  });

  const result = await runner.runOnce();
  assert.equal(result.status, "failed");
  assert.equal(result.error, expected);
  assert.deepEqual(failedWith, ["job", expected]);
});

test("runner renews a lease while processing", async () => {
  let renewals = 0;
  const runner = createMemoryProcessingRunner({
    storage: createFakeStorage({
      async renewLease() {
        renewals += 1;
      },
    }),
    handler: {
      async process() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {};
      },
      async commit() {},
    },
    workerId: "worker",
    leaseDurationMs: 30,
    renewalIntervalMs: 5,
  });

  assert.equal((await runner.runOnce()).status, "succeeded");
  assert.ok(renewals >= 1);
});

test("runner reports idle when no revision is claimable", async () => {
  const runner = createMemoryProcessingRunner({
    storage: createFakeStorage({
      async claimNext() {
        return null;
      },
    }),
    handler: { async process() {}, async commit() {} },
    workerId: "worker",
  });
  assert.deepEqual(await runner.runOnce(), { status: "idle" });
});
