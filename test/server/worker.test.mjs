import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkerConfig } from "../../src/server/worker/config.mjs";
import { runMemoryWorker } from "../../src/server/worker/lifecycle.mjs";

function environment(overrides = {}) {
  return {
    MEMORY_PROCESSING_ENABLED: "true",
    DATABASE_WORKER_URL: "postgresql://worker:fixture@localhost/synapse_test",
    DATABASE_SSL: "disable",
    OPENAI_API_KEY: "fixture-not-a-secret",
    MEMORY_MODEL: "fixture-model",
    ...overrides,
  };
}

test("worker is opt-in and requires separate credentials and explicit models", () => {
  assert.deepEqual(loadWorkerConfig({}), { enabled: false });
  assert.deepEqual(
    loadWorkerConfig({
      MEMORY_PROCESSING_ENABLED: "false",
      DATABASE_SSL: "invalid",
    }),
    { enabled: false },
  );
  assert.throws(
    () => loadWorkerConfig({ MEMORY_PROCESSING_ENABLED: "yes" }),
    /true or false/,
  );
  for (const key of ["DATABASE_WORKER_URL", "OPENAI_API_KEY", "MEMORY_MODEL"]) {
    assert.throws(
      () => loadWorkerConfig(environment({ [key]: "" })),
      new RegExp(key),
    );
  }
  const config = loadWorkerConfig(environment());
  assert.equal(config.model, "fixture-model");
  assert.equal(config.reviewModel, "fixture-model");
  assert.equal(config.reviewStrategy, "always");
  assert.equal(config.databaseSsl, false);
  assert.equal(config.maxStageCalls, 2);
  assert.equal(
    loadWorkerConfig(environment({ MEMORY_REVIEW_MODEL: "review-fixture" }))
      .reviewModel,
    "review-fixture",
  );
  assert.throws(
    () => loadWorkerConfig(environment({ NODE_ENV: "production" })),
    /verify-full/,
  );
  assert.deepEqual(
    loadWorkerConfig(
      environment({
        NODE_ENV: "production",
        DATABASE_SSL: "verify-full",
        DATABASE_CA_CERT: "fixture-ca",
      }),
    ).databaseSsl,
    { rejectUnauthorized: true, ca: "fixture-ca" },
  );
});

test("worker request, retry and polling configuration is bounded", () => {
  assert.equal(loadWorkerConfig(environment()).maxOutputTokens, 8000);
  assert.equal(
    loadWorkerConfig(environment({ MEMORY_MAX_OUTPUT_TOKENS: "32000" }))
      .maxOutputTokens,
    32000,
  );
  assert.throws(
    () => loadWorkerConfig(environment({ MEMORY_MAX_OUTPUT_TOKENS: "32001" })),
    /MEMORY_MAX_OUTPUT_TOKENS/,
  );
  for (const key of [
    "MEMORY_MAX_STAGE_CALLS",
    "MEMORY_REQUEST_TIMEOUT_MS",
    "MEMORY_MAX_OUTPUT_TOKENS",
    "MEMORY_POLL_INTERVAL_MS",
    "MEMORY_ERROR_DELAY_MS",
    "MEMORY_LEASE_DURATION_MS",
  ]) {
    for (const value of ["0", "-1", "1.5", "infinity", "999999999"]) {
      assert.throws(
        () => loadWorkerConfig(environment({ [key]: value })),
        new RegExp(key),
      );
    }
  }
  assert.equal(
    loadWorkerConfig(environment({ MEMORY_POLL_INTERVAL_MS: "1234" }))
      .pollIntervalMs,
    1234,
  );
});

test("worker serially drains jobs, backs off idle/errors and sanitizes logging", async () => {
  const controller = new AbortController();
  const logs = [];
  const waits = [];
  const sequence = [
    { status: "succeeded", jobId: "job-1" },
    { status: "idle" },
    new Error("private source and secret"),
    {
      status: "failed",
      jobId: "job-2",
      error: new Error("private provider response"),
    },
  ];
  const runner = {
    enabled: true,
    async runOnce() {
      const next = sequence.shift();
      if (!sequence.length) controller.abort();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const result = await runMemoryWorker({
    runner,
    logger: {
      info: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
    signal: controller.signal,
    pollIntervalMs: 11,
    errorDelayMs: 22,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(result, { status: "stopped" });
  assert.deepEqual(waits, [11, 22]);
  assert.equal(logs.length, 3);
  assert.doesNotMatch(JSON.stringify(logs), /private|secret|provider/);
});

test("disabled or stopped worker never claims work", async () => {
  const controller = new AbortController();
  const runner = {
    enabled: false,
    runOnce() {
      assert.fail("must not claim");
    },
  };
  assert.deepEqual(
    await runMemoryWorker({ runner, signal: controller.signal }),
    { status: "disabled" },
  );
  controller.abort();
  runner.enabled = true;
  assert.deepEqual(
    await runMemoryWorker({ runner, signal: controller.signal }),
    { status: "stopped" },
  );
});

test("stop interrupts idle wait, and disabled runner result terminates", async () => {
  const controller = new AbortController();
  const logger = { info() {}, error() {} };
  const pending = runMemoryWorker({
    runner: {
      enabled: true,
      async runOnce() {
        return { status: "idle" };
      },
    },
    logger,
    signal: controller.signal,
    pollIntervalMs: 60_000,
  });
  setImmediate(() => controller.abort());
  assert.deepEqual(await pending, { status: "stopped" });
  assert.deepEqual(
    await runMemoryWorker({
      runner: {
        enabled: true,
        async runOnce() {
          return { status: "disabled" };
        },
      },
      signal: new AbortController().signal,
    }),
    { status: "disabled" },
  );
});

test("failed jobs delay before another claim", async () => {
  const controller = new AbortController();
  let calls = 0;
  await runMemoryWorker({
    runner: {
      enabled: true,
      async runOnce() {
        calls++;
        return { status: "failed", jobId: "fixture" };
      },
    },
    logger: { info() {} },
    signal: controller.signal,
    errorDelayMs: 42,
    wait: async (ms) => {
      assert.equal(ms, 42);
      controller.abort();
    },
  });
  assert.equal(calls, 1);
});
