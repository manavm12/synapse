import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyMemoryChangeSet,
  emptyLedger,
  extractionSchema,
  normalizeSourceEnvelope,
} from "../../src/memory/core/index.mjs";
import {
  createMemoryInferenceAPI,
  MemoryInferenceError,
} from "../../src/server/memory-organizer/api.mjs";
import { createMemoryOrganizerHandler } from "../../src/server/memory-organizer/handler.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../fixtures/memory-core/log-retention.json", import.meta.url),
    "utf8",
  ),
);
const now = () => new Date("2026-09-07T01:00:00.000Z");

function setup({ reviewStrategy = "always", maxStageCalls = 3, respond } = {}) {
  let ledger = emptyLedger(fixture.identity);
  let commits = 0;
  const calls = [];
  const adapter = {
    async loadSource(envelope) {
      return {
        source: normalizeSourceEnvelope(envelope, fixture.identity),
        ledger,
      };
    },
    async commit({ result }) {
      commits++;
      ledger = applyMemoryChangeSet(ledger, result.changeSet);
    },
  };
  const api = {
    model: "synthetic-extractor",
    reviewer: "synthetic-reviewer",
    async structured(stage, prompt, schema, options) {
      const data = JSON.parse(prompt.split("\n").at(-1));
      calls.push({ stage, data, schema, options });
      const value = respond
        ? await respond(stage, data, calls)
        : stage === "extract"
          ? structuredClone(fixture.steps[ledger.version ? 1 : 0].extraction)
          : stage === "reconcile"
            ? structuredClone(fixture.steps[1].reconciliation)
            : { issues: [] };
      return { value, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const handler = createMemoryOrganizerHandler({
    adapter,
    api,
    now,
    reviewStrategy,
    maxStageCalls,
  });
  return {
    handler,
    calls,
    get ledger() {
      return ledger;
    },
    get commits() {
      return commits;
    },
  };
}

test("handler extracts/reconciles/reviews and commits only when explicitly invoked", async () => {
  const run = setup();
  const first = await run.handler.process(fixture.steps[0].envelope);
  assert.deepEqual(
    run.calls.map((call) => call.stage),
    ["extract", "review"],
  );
  assert.equal(run.commits, 0);
  assert.equal(first.audit.reviewPassed, true);
  assert.ok(
    first.audit.calls.every((call) => /^[a-f0-9]{64}$/.test(call.promptHash)),
  );
  await run.handler.commit({
    source: fixture.steps[0].envelope,
    result: first,
  });
  const second = await run.handler.process(fixture.steps[1].envelope);
  assert.deepEqual(
    run.calls.slice(2).map((call) => call.stage),
    ["extract", "reconcile", "review"],
  );
  const reconcile = run.calls.find((call) => call.stage === "reconcile");
  assert.deepEqual(
    reconcile.schema.properties.actions.items.properties.targets.items.enum,
    run.ledger.claims.map((claim) => claim.id),
  );
  assert.equal(
    reconcile.schema.properties.actions.items.properties.reason.enum,
    undefined,
  );
  await run.handler.commit({
    source: fixture.steps[1].envelope,
    result: second,
  });
  assert.equal(run.ledger.version, 2);
  assert.equal(run.ledger.relations[0].type, "supersedes");
});

test("review rejection and structural repairs stay inside per-stage budgets", async () => {
  let extracts = 0;
  let reviews = 0;
  const run = setup({
    respond(stage) {
      if (stage === "extract") {
        extracts++;
        return fixture.steps[0].extraction;
      }
      return {
        issues:
          ++reviews === 1
            ? [
                {
                  stage: "extraction",
                  ref: "c1",
                  detail: "Synthetic repair request",
                },
              ]
            : [],
      };
    },
  });
  const result = await run.handler.process(fixture.steps[0].envelope);
  assert.equal(extracts, 2);
  assert.equal(reviews, 2);
  assert.equal(result.audit.stageCalls.extract, 2);
  const failed = setup({
    maxStageCalls: 2,
    respond(stage) {
      return stage === "extract"
        ? fixture.steps[0].extraction
        : {
            issues: [
              { stage: "extraction", ref: "c1", detail: "private source text" },
            ],
          };
    },
  });
  await assert.rejects(
    failed.handler.process(fixture.steps[0].envelope),
    (error) =>
      /semantic review rejected/.test(error.message) &&
      !error.message.includes("private"),
  );
  assert.equal(failed.calls.length, 4);
  assert.equal(failed.commits, 0);

  let attempts = 0;
  const structural = setup({
    respond(stage) {
      if (stage === "review") return { issues: [] };
      const extraction = structuredClone(fixture.steps[0].extraction);
      if (++attempts === 1) extraction.coverage = [];
      return extraction;
    },
  });
  await structural.handler.process(fixture.steps[0].envelope);
  assert.equal(attempts, 2);
});

test("transport retries reuse inputs and are bounded; failed requests never commit", async () => {
  let extracts = 0;
  const run = setup({
    maxStageCalls: 2,
    respond(stage) {
      if (stage === "extract" && ++extracts === 1)
        throw new MemoryInferenceError("HTTP 429", {
          transport: true,
          retryable: true,
        });
      return stage === "extract" ? fixture.steps[0].extraction : { issues: [] };
    },
  });
  const result = await run.handler.process(fixture.steps[0].envelope);
  assert.equal(result.audit.stageCalls.extract, 2);
  assert.deepEqual(run.calls[0].data, run.calls[1].data);
  const failed = setup({
    maxStageCalls: 2,
    respond() {
      throw new MemoryInferenceError("HTTP 503", {
        transport: true,
        retryable: true,
      });
    },
  });
  await assert.rejects(
    failed.handler.process(fixture.steps[0].envelope),
    /503/,
  );
  assert.equal(failed.calls.length, 2);
  assert.equal(failed.commits, 0);
});

test("review strategy is explicit and empty extraction has no reconciliation call", async () => {
  const run = setup({
    reviewStrategy: "never",
    respond() {
      return {
        claims: [],
        coverage: fixture.steps[0].extraction.coverage.map((entry) => ({
          ...entry,
          disposition: "context",
        })),
      };
    },
  });
  const result = await run.handler.process(fixture.steps[0].envelope);
  assert.equal(result.audit.reviewStrategy, "never");
  assert.equal(result.audit.reviewPassed, false);
  assert.equal(run.calls.length, 1);
  assert.equal(result.changeSet.append.claims.length, 0);
  await assert.rejects(setup().handler.commit({ result }), /review strategy/);
  assert.throws(() => setup({ reviewStrategy: "selective" }), /reviewStrategy/);
  assert.throws(() => setup({ maxStageCalls: 4 }), /maxStageCalls/);
});

const rawResponse = (value) => ({
  status: "completed",
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    },
  ],
  usage: { input_tokens: 12, output_tokens: 4 },
});
const apiOptions = {
  apiKey: "synthetic-test-key",
  model: "synthetic-model",
  reviewer: "synthetic-review",
};

test("real API adapter uses strict Responses output, store false and bounded requests", async () => {
  const requests = [];
  const api = createMemoryInferenceAPI({
    ...apiOptions,
    maxOutputTokens: 8000,
    fetcher: async (url, options) => {
      requests.push({ url, ...options });
      return Response.json(rawResponse(fixture.steps[0].extraction));
    },
  });
  const result = await api.structured(
    "extract",
    "Synthetic prompt",
    extractionSchema,
  );
  assert.deepEqual(result.value, fixture.steps[0].extraction);
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4 });
  const request = JSON.parse(requests[0].body);
  assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
  assert.equal(requests[0].redirect, "error");
  assert.equal(request.store, false);
  assert.equal(request.service_tier, "default");
  assert.equal(request.truncation, "disabled");
  assert.equal(request.text.format.strict, true);
  assert.equal(request.max_output_tokens, 8000);
  assert.ok(!Object.hasOwn(api, "apiKey"));
});

test("API refuses malformed, incomplete, refused, oversized and error responses without leaking bodies", async () => {
  for (const response of [
    () => Response.json({ status: "incomplete" }),
    () =>
      Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "private provider detail" }],
          },
        ],
      }),
    () => new Response("private provider error", { status: 401 }),
    () => new Response("not JSON"),
    () => Response.json(rawResponse({ invalid: "private text" })),
  ]) {
    const api = createMemoryInferenceAPI({
      ...apiOptions,
      fetcher: async () => response(),
    });
    await assert.rejects(
      api.structured("extract", "prompt", extractionSchema),
      (error) =>
        error instanceof MemoryInferenceError &&
        !error.message.includes("private"),
    );
  }
  const oversized = createMemoryInferenceAPI({
    ...apiOptions,
    maxResponseBytes: 20,
    fetcher: async () => new Response("x".repeat(21)),
  });
  await assert.rejects(
    oversized.structured("extract", "prompt", extractionSchema),
    /size exceeded/,
  );
  const limited = createMemoryInferenceAPI({
    ...apiOptions,
    maxPromptCharacters: 5,
    fetcher: async () => assert.fail("No request expected"),
  });
  await assert.rejects(
    limited.structured("extract", "too long", extractionSchema),
    /prompt size/,
  );
});

test("incomplete responses retain only safe stage, reason and token diagnostics", async () => {
  for (const [status, reason, expected] of [
    ["incomplete", "max_output_tokens", "output token limit reached"],
    ["incomplete", "content_filter", "content filtered"],
    ["incomplete", "private provider secret", "incomplete response"],
    ["failed", undefined, "provider response failed"],
    ["private provider status", undefined, "incomplete response"],
  ]) {
    const api = createMemoryInferenceAPI({
      ...apiOptions,
      maxOutputTokens: 32_000,
      fetcher: async () =>
        Response.json({
          status,
          incomplete_details: { reason },
          output: [{ text: "private partial output" }],
          error: { message: "private provider secret" },
          usage: {
            input_tokens: 120,
            output_tokens: 32000,
            output_tokens_details: { reasoning_tokens: 31000 },
          },
        }),
    });
    await assert.rejects(
      api.structured("extract", "prompt", extractionSchema),
      (error) => {
        assert.equal(error.code, expected);
        assert.equal(error.details.inference_stage, "extract");
        assert.equal(error.details.input_tokens, 120);
        assert.equal(error.details.output_tokens, 32000);
        assert.equal(error.details.reasoning_tokens, 31000);
        assert.equal(error.details.max_output_tokens, 32000);
        assert.equal(error.retryable, false);
        assert.equal(error.transport, false);
        assert.doesNotMatch(JSON.stringify(error), /private/);
        assert.ok(Object.isFrozen(error.details));
        assert.throws(() => {
          error.details = { secret: "private" };
        });
        return true;
      },
    );
  }
  const error = new MemoryInferenceError("incomplete response", {
    details: {
      inference_stage: "private",
      response_status: "private",
      incomplete_reason: "private",
      input_tokens: -1,
      output_tokens: "private",
      reasoning_tokens: Number.MAX_SAFE_INTEGER + 1,
      arbitrary: "private",
    },
  });
  assert.deepEqual(error.details, {});
  assert.throws(
    () => createMemoryInferenceAPI({ ...apiOptions, maxOutputTokens: 32001 }),
    /maxOutputTokens/,
  );
});

test("API deadline covers stalled fetch/body and shutdown cancels an in-flight request", async () => {
  const stalledFetch = createMemoryInferenceAPI({
    ...apiOptions,
    timeoutMs: 10,
    fetcher: () => new Promise(() => {}),
  });
  await assert.rejects(
    stalledFetch.structured("extract", "prompt", extractionSchema),
    /timeout/,
  );
  const stalledBody = createMemoryInferenceAPI({
    ...apiOptions,
    timeoutMs: 10,
    fetcher: async () => new Response(new ReadableStream({ start() {} })),
  });
  await assert.rejects(
    stalledBody.structured("extract", "prompt", extractionSchema),
    /timeout/,
  );
  const controller = new AbortController();
  const cancelled = createMemoryInferenceAPI({
    ...apiOptions,
    fetcher: (_url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled"))),
      ),
  });
  const promise = cancelled.structured("extract", "prompt", extractionSchema, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(promise, /cancelled/);
});
