import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkerConfig } from "../../src/server/worker/config.mjs";
import { createWorkerRuntime } from "../../src/server/worker/runtime.mjs";

const config = loadWorkerConfig({
  MEMORY_PROCESSING_ENABLED: "true",
  DATABASE_WORKER_URL: "postgresql://fixture:fixture@localhost/test",
  DATABASE_SSL: "disable",
  OPENAI_API_KEY: "fixture",
  MEMORY_MODEL: "model-fixture",
});

function dependencies(overrides = {}) {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(["role-check", sql]);
      return {
        rows: [
          {
            worker: true,
            runtime: false,
            rolsuper: false,
            rolbypassrls: false,
          },
        ],
      };
    },
    async end() {
      calls.push(["close"]);
    },
  };
  const deps = {
    createPool(options) {
      calls.push(["pool", options]);
      return pool;
    },
    createAdapter(options) {
      calls.push(["adapter", options]);
      return { adapter: true };
    },
    createAPI(options) {
      calls.push(["api", options]);
      return { api: true };
    },
    createHandler(options) {
      calls.push(["handler", options]);
      return { handler: true };
    },
    createStorage(options) {
      calls.push(["storage", options]);
      return { storage: true };
    },
    createRunner(options) {
      calls.push(["runner", options]);
      return { enabled: false };
    },
    logger: { info() {}, error() {} },
    signal: new AbortController().signal,
    workerId: "worker-fixture",
    ...overrides,
  };
  return { deps, calls, pool };
}

test("disabled runtime initializes no dependencies", async () => {
  const runtime = await createWorkerRuntime({ enabled: false }, {});
  assert.equal(runtime.enabled, false);
  assert.deepEqual(await runtime.run(), { status: "disabled" });
  await runtime.close();
});

test("worker runtime checks the dedicated DB role before constructing inference", async () => {
  const { deps, calls, pool } = dependencies();
  const runtime = await createWorkerRuntime(config, deps);
  assert.equal(runtime.enabled, true);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["pool", "role-check", "adapter", "api", "handler", "storage", "runner"],
  );
  assert.deepEqual(calls.find(([name]) => name === "adapter")[1], { pool });
  assert.equal(
    calls.find(([name]) => name === "pool")[1].connectionString,
    config.databaseUrl,
  );
  assert.deepEqual(calls.find(([name]) => name === "api")[1], {
    apiKey: "fixture",
    model: "model-fixture",
    reviewer: "model-fixture",
    timeoutMs: 60_000,
    maxOutputTokens: 8_000,
  });
  assert.equal(
    calls.find(([name]) => name === "handler")[1].signal,
    deps.signal,
  );
  assert.equal(calls.find(([name]) => name === "handler")[1].maxStageCalls, 2);
  assert.equal(
    calls.find(([name]) => name === "runner")[1].workerId,
    "worker-fixture",
  );
  assert.deepEqual(await runtime.run(), { status: "disabled" });
  await runtime.close();
  await runtime.close();
  assert.equal(calls.filter(([name]) => name === "close").length, 1);
});

test("worker refuses runtime/admin/bypass roles and releases the pool", async () => {
  for (const role of [
    undefined,
    { worker: false },
    { worker: true, runtime: true },
    { worker: true, rolsuper: true },
    { worker: true, rolbypassrls: true },
  ]) {
    const { deps, calls, pool } = dependencies();
    pool.query = async () => ({ rows: role ? [role] : [] });
    await assert.rejects(
      createWorkerRuntime(config, deps),
      /dedicated non-superuser/,
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      ["pool", "close"],
    );
  }
});

test("worker startup failures close owned pool without starting jobs", async () => {
  const { deps, calls, pool } = dependencies();
  pool.query = async () => {
    throw new Error("offline");
  };
  await assert.rejects(createWorkerRuntime(config, deps), /offline/);
  assert.equal(calls.filter(([name]) => name === "close").length, 1);
  const other = dependencies({
    createAPI() {
      throw new Error("invalid model");
    },
  });
  await assert.rejects(
    createWorkerRuntime(config, other.deps),
    /invalid model/,
  );
  assert.equal(other.calls.filter(([name]) => name === "close").length, 1);
  assert.equal(
    other.calls.some(([name]) => name === "runner"),
    false,
  );
});
