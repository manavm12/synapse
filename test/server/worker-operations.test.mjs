import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MemoryInferenceError } from "../../src/server/memory-organizer/api.mjs";
import { createMemoryProcessingRunner } from "../../src/server/memory-processing/runner.mjs";
import {
  createMemoryProcessingStorage,
  MemoryProcessingLeaseLostError,
} from "../../src/server/memory-processing/storage.mjs";
import { loadWorkerDatabaseConfig } from "../../src/server/worker/config.mjs";
import {
  WorkerDatabaseError,
  workerFailureCategory,
  workerFailureDetails,
} from "../../src/server/worker/diagnostics.mjs";
import { runMemoryWorker } from "../../src/server/worker/lifecycle.mjs";
import { parseWorkerArguments } from "../../src/server/worker/options.mjs";
import { createWorkerRuntime } from "../../src/server/worker/runtime.mjs";
import { runStatusCli } from "../../src/server/worker/status.mjs";

const scope = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
};
const scopeArgs = [
  "--owner-id",
  scope.ownerId,
  "--project-id",
  scope.projectId,
];

test("canary options require exact scope and an explicit bounded attempt count", () => {
  assert.deepEqual(parseWorkerArguments([]), { scope: null, maxJobs: null });
  assert.deepEqual(
    parseWorkerArguments(["--canary", ...scopeArgs, "--max-jobs", "2"]),
    { scope, maxJobs: 2 },
  );
  assert.deepEqual(parseWorkerArguments(scopeArgs, { status: true }), {
    scope,
  });
  for (const args of [
    [],
    ["--owner-id", scope.ownerId],
    [...scopeArgs, "--max-jobs", "0"],
    [...scopeArgs, "--max-jobs", "1001"],
    [...scopeArgs, "--max-jobs", "1.5"],
    [...scopeArgs, "--max-jobs", "1e2"],
    [...scopeArgs, "--owner-id", scope.ownerId],
    ["--owner-id", "secret-value", "--project-id", scope.projectId],
    ["--unknown", "value"],
  ])
    assert.throws(() => parseWorkerArguments(["--canary", ...args]));
  assert.throws(() => parseWorkerArguments(scopeArgs));
  assert.throws(() =>
    createMemoryProcessingStorage({ scope: { ownerId: scope.ownerId } }),
  );
  assert.throws(() =>
    loadWorkerDatabaseConfig({
      DATABASE_WORKER_URL: "fixture",
      DATABASE_SSL: "bad",
    }),
  );
});

test("revision targeting requires a UUID and exactly one canary attempt", async () => {
  const revisionId = "33333333-3333-4333-8333-333333333333";
  assert.deepEqual(
    parseWorkerArguments([
      "--canary",
      ...scopeArgs,
      "--max-jobs",
      "1",
      "--revision-id",
      revisionId,
    ]),
    {
      scope: { ...scope, revisionId },
      maxJobs: 1,
    },
  );
  for (const tail of [
    ["--max-jobs", "2", "--revision-id", revisionId],
    ["--max-jobs", "1", "--revision-id", "private-secret"],
    [
      "--max-jobs",
      "1",
      "--revision-id",
      revisionId,
      "--revision-id",
      revisionId,
    ],
  ])
    assert.throws(() =>
      parseWorkerArguments(["--canary", ...scopeArgs, ...tail]),
    );
  assert.throws(() =>
    parseWorkerArguments([...scopeArgs, "--revision-id", revisionId], {
      status: true,
    }),
  );
  await assert.rejects(
    createWorkerRuntime(
      { enabled: true },
      { scope: { ...scope, revisionId }, maxJobs: 2 },
    ),
    /canary/,
  );
});

test("canary counts attempts, stops on failure, reports incomplete work and never retries", async () => {
  for (const [sequence, expected] of [
    [
      ["succeeded", "succeeded", "succeeded"],
      { status: "limit_reached", attempts: 2, succeeded: 2 },
    ],
    [
      ["succeeded", "failed", "succeeded"],
      { status: "failed", attempts: 2, succeeded: 1 },
    ],
    [["idle"], { status: "blocked", attempts: 0, succeeded: 0 }],
    [
      [new Error("private secret")],
      { status: "failed", attempts: 0, succeeded: 0 },
    ],
  ]) {
    let calls = 0;
    const logs = [];
    const result = await runMemoryWorker({
      runner: {
        enabled: true,
        async runOnce() {
          const next = sequence[calls++];
          if (next instanceof Error) throw next;
          return {
            status: next,
            jobId: "job",
            queueStatus: "pending",
            error: new Error("private secret"),
          };
        },
      },
      logger: {
        info: (...args) => logs.push(args),
        error: (...args) => logs.push(args),
      },
      signal: new AbortController().signal,
      maxJobs: 2,
      describeIdle: async () => "blocked",
      wait: async () => assert.fail("a canary must not poll or retry"),
    });
    assert.deepEqual(result, expected);
    assert.ok(calls <= 2);
    assert.doesNotMatch(JSON.stringify(logs), /private|secret/);
  }
  await assert.rejects(runMemoryWorker({ maxJobs: 0 }), /maxJobs/);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await runMemoryWorker({
      runner: { enabled: true },
      signal: controller.signal,
      maxJobs: 1,
    }),
    { status: "stopped", attempts: 0, succeeded: 0 },
  );
});

test("diagnostics use fixed categories without exposing arbitrary messages", () => {
  for (const [error, expected] of [
    [new WorkerDatabaseError("database_role"), "database_role"],
    [new WorkerDatabaseError("secret"), "database"],
    [new MemoryProcessingLeaseLostError(), "lease_lost"],
    [{ name: "MemoryLedgerGenerationError" }, "ledger_generation"],
    [new MemoryInferenceError("HTTP 403"), "model_access"],
    [new MemoryInferenceError("HTTP 429"), "model_rate_limit"],
    [new MemoryInferenceError("timeout"), "model_timeout"],
    [new MemoryInferenceError("cancelled"), "cancelled"],
    [
      new MemoryInferenceError("context limit reached; no truncation"),
      "context_limit",
    ],
    [
      new MemoryInferenceError("semantic review rejected proposal"),
      "review_rejected",
    ],
    [new MemoryInferenceError("incomplete response"), "model_incomplete"],
    [
      new MemoryInferenceError("output token limit reached"),
      "model_output_limit",
    ],
    [new MemoryInferenceError("content filtered"), "model_content_filter"],
    [
      new MemoryInferenceError("provider response failed"),
      "model_response_failed",
    ],
    [
      new MemoryInferenceError("transport failure", { transport: true }),
      "model_transport",
    ],
    [new MemoryInferenceError("private response"), "model_validation"],
    [{ code: "42P01", message: "private schema" }, "database_schema"],
    [{ code: "42501" }, "database_permissions"],
    [{ code: "57014" }, "database_timeout"],
    [{ code: "ECONNREFUSED" }, "database_connection"],
    [new Error("secret token"), "unknown"],
  ])
    assert.equal(workerFailureCategory(error), expected);
  assert.deepEqual(workerFailureDetails(new Error("secret")), {});
  assert.deepEqual(
    workerFailureDetails(
      new MemoryInferenceError("output token limit reached", {
        details: {
          inference_stage: "extract",
          output_tokens: 8000,
          secret: "private",
        },
      }),
    ),
    { inference_stage: "extract", output_tokens: 8000 },
  );
});

test("failed canary logs fixed inference details without provider text", async () => {
  const logs = [];
  await runMemoryWorker({
    runner: {
      enabled: true,
      async runOnce() {
        return {
          status: "failed",
          jobId: "job",
          queueStatus: "pending",
          error: new MemoryInferenceError("output token limit reached", {
            details: {
              inference_stage: "review",
              incomplete_reason: "max_output_tokens",
              output_tokens: 8000,
              body: "private",
            },
          }),
        };
      },
    },
    logger: {
      info: (event, fields) => logs.push({ event, ...fields }),
      error() {},
    },
    signal: new AbortController().signal,
    maxJobs: 1,
  });
  assert.equal(logs[0].category, "model_output_limit");
  assert.equal(logs[0].inference_stage, "review");
  assert.equal(logs[0].output_tokens, 8000);
  assert.doesNotMatch(JSON.stringify(logs), /private/);
});

test("runner exposes retry versus terminal failure and loss of lease", async () => {
  for (const expected of ["pending", "failed", "lease_lost"]) {
    const runner = createMemoryProcessingRunner({
      workerId: "fixture",
      storage: {
        claimNext: async () => ({ id: "fixture", source: {} }),
        async fail() {
          if (expected === "lease_lost")
            throw new MemoryProcessingLeaseLostError();
          return expected;
        },
      },
      handler: {
        async process() {
          throw new Error("private source");
        },
        async commit() {},
      },
    });
    assert.equal((await runner.runOnce()).queueStatus, expected);
  }
});

test("status works with processing disabled and no inference credential, and sanitizes failures", async () => {
  let output = "",
    calls = 0;
  const stdout = {
    write(value) {
      output += value;
    },
  };
  assert.equal(await runStatusCli(["--help"], { env: {}, stdout }), 0);
  assert.match(output, /Read-only/);
  output = "";
  assert.equal(
    await runStatusCli(scopeArgs, {
      env: {},
      stdout,
      createPool() {
        calls++;
      },
    }),
    1,
  );
  assert.equal(calls, 0);
  assert.equal(JSON.parse(output).category, "configuration");
  output = "";
  assert.equal(
    await runStatusCli(scopeArgs, {
      env: { DATABASE_WORKER_URL: "private-secret", DATABASE_SSL: "disable" },
      stdout,
    }),
    1,
  );
  assert.doesNotMatch(output, /private-secret/);
  await assert.rejects(
    createWorkerRuntime({ enabled: true }, { scope, maxJobs: null }),
    /canary/,
  );
});

test("worker executable help, disabled startup and invalid canary cannot invoke inference", () => {
  const entry = fileURLToPath(
    new URL("../../src/server/worker/index.mjs", import.meta.url),
  );
  for (const [args, expected] of [
    [[], 0],
    [["--help"], 0],
    [["--canary", ...scopeArgs, "--max-jobs", "1"], 1],
    [["--bogus", "private-secret"], 1],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, MEMORY_PROCESSING_ENABLED: "false" },
    });
    assert.equal(result.status, expected, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /private-secret/);
  }
});
