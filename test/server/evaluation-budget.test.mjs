import assert from "node:assert/strict";
import test from "node:test";
import { createEvaluationBudget } from "../../scripts/lib/evaluation-budget.mjs";

const endpoint = "https://api.openai.com/v1/responses";
const modelRates = {
  "test-model": { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5 },
};
const body = (overrides = {}) => ({
  model: "test-model",
  input: "Private evaluation prompt",
  max_output_tokens: 100,
  service_tier: "default",
  ...overrides,
});
const request = (overrides = {}, init = {}) => ({
  method: "POST",
  headers: {
    Authorization: "Bearer private-secret",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body(overrides)),
  ...init,
});
const response = (overrides = {}) =>
  Response.json({
    status: "completed",
    service_tier: "default",
    output: [{ text: "Private response content" }],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 15 },
    },
    ...overrides,
  });

test("evaluation requires an explicit bounded budget and positive exact-model rates", () => {
  for (const budgetUsd of [undefined, 0, -1, 5.01, NaN, Infinity, "5"])
    assert.throws(
      () => createEvaluationBudget({ budgetUsd, modelRates }),
      /explicit budget/,
    );
  for (const rates of [
    undefined,
    {},
    { "test-model": {} },
    { "test-model": { inputUsdPerMillion: 0, outputUsdPerMillion: 1 } },
  ])
    assert.throws(() =>
      createEvaluationBudget({ budgetUsd: 1, modelRates: rates }),
    );
});

test("successful usage refunds only reserved cost and charges cached input and all reasoning output", async () => {
  let observed;
  const guard = createEvaluationBudget({
    budgetUsd: 1,
    modelRates,
    fetchImpl: async (url, init) => {
      observed = {
        url,
        redirect: init.redirect,
        body: JSON.parse(init.body),
        auth: init.headers.get("authorization"),
      };
      assert.ok(guard.summary().reservedUsd > 0);
      return response();
    },
  });
  const result = await guard.fetch(endpoint, request());
  assert.equal(
    (await result.json()).output[0].text,
    "Private response content",
  );
  assert.equal(observed.url, endpoint);
  assert.equal(observed.redirect, "error");
  assert.equal(observed.body.store, false);
  assert.equal(observed.body.stream, false);
  assert.equal(observed.auth, "Bearer private-secret");
  const summary = guard.summary();
  assert.equal(summary.spentUsd, (10 * 0.75 + 20 * 4.5) / 1_000_000);
  assert.equal(summary.reservedUsd, 0);
  assert.deepEqual(summary.calls, {
    attempted: 1,
    succeeded: 1,
    failed: 0,
    rejected: 0,
    inFlight: 0,
  });
  assert.doesNotMatch(
    JSON.stringify(summary),
    /private|Bearer|prompt|response content/i,
  );
  summary.calls.attempted = 900;
  assert.equal(guard.summary().calls.attempted, 1);
});

test("concurrent requests cannot reuse outstanding reservations", async () => {
  let finish;
  let requests = 0;
  const guard = createEvaluationBudget({
    budgetUsd: 0.01,
    modelRates,
    fetchImpl: () => {
      requests++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = guard.fetch(endpoint, request());
  assert.equal(guard.summary().calls.inFlight, 1);
  await assert.rejects(guard.fetch(endpoint, request()), { code: "budget" });
  assert.equal(requests, 1);
  assert.ok(guard.summary().spentUsd + guard.summary().reservedUsd <= 0.01);
  finish(response());
  await first;
  const third = guard.fetch(endpoint, request());
  finish(response());
  await third;
  assert.equal(requests, 2);
});

test("preflight rejects unknown models, expensive requests and non-text or indirect billing paths", async () => {
  let requests = 0;
  const guard = createEvaluationBudget({
    budgetUsd: 1,
    modelRates,
    fetchImpl: async () => {
      requests++;
      return response();
    },
  });
  for (const overrides of [
    { model: "unpriced-model" },
    { max_output_tokens: 1_000_000 },
    { max_output_tokens: 0 },
    { max_output_tokens: 1.5 },
    { service_tier: "auto" },
    { service_tier: "priority" },
    { stream: true },
    { store: true },
    { tools: [] },
    { tool_choice: "auto" },
    { previous_response_id: "resp_remote" },
    { conversation: "conv_remote" },
    { prompt: { id: "pmpt_remote" } },
    { input: [{ type: "item_reference", id: "item_remote" }] },
    {
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "https://example.test/image" },
          ],
        },
      ],
    },
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_file", file_id: "file_remote" }],
        },
      ],
    },
    {
      input: [
        { type: "function_call_output", call_id: "tool", output: "result" },
      ],
    },
  ])
    await assert.rejects(guard.fetch(endpoint, request(overrides)));
  for (const url of [
    "http://api.openai.com/v1/responses",
    `${endpoint}?key=secret`,
    `${endpoint}/`,
    "https://api.openai.com/v1/chat/completions",
    "https://example.test/v1/responses",
  ])
    await assert.rejects(guard.fetch(url, request()));
  for (const init of [
    { method: "GET" },
    { redirect: "follow" },
    { body: "not json" },
    { body: new Uint8Array([1]) },
    { headers: { "content-type": "text/plain" } },
    {
      headers: {
        "content-type": "application/json",
        "x-http-method-override": "GET",
      },
    },
  ])
    await assert.rejects(guard.fetch(endpoint, request({}, init)));
  assert.equal(requests, 0);
  assert.equal(guard.summary().spentUsd, 0);
  assert.equal(guard.summary().reservedUsd, 0);
});

test("text messages, UTF-8 and structured JSON output receive conservative reservations", async () => {
  const amounts = [];
  const guard = createEvaluationBudget({
    budgetUsd: 1,
    modelRates,
    fetchImpl: async () => {
      amounts.push(guard.summary().reservedUsd);
      return response();
    },
  });
  await guard.fetch(endpoint, request({ input: "cafe" }));
  await guard.fetch(endpoint, request({ input: "café" }));
  await guard.fetch(
    new URL(endpoint),
    request({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "café" }],
        },
      ],
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "result",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    }),
  );
  assert.ok(amounts[1] > amounts[0]);
  assert.ok(amounts[2] > amounts[1]);
});

test("HTTP, transport, invalid JSON, missing usage and streaming failures permanently spend reservations", async () => {
  for (const run of [
    () => {
      throw new Error("private-secret Private evaluation prompt");
    },
    () => {
      const error = new Error("private-secret Private evaluation prompt");
      error.name = "EvaluationBudgetError";
      throw error;
    },
    () => Response.json({ error: "Private response content" }, { status: 500 }),
    () =>
      new Response("", {
        status: 302,
        headers: { location: "https://example.test" },
      }),
    () =>
      new Response("Private response content", {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("data: Private response content", {
        headers: { "content-type": "text/event-stream" },
      }),
    () => response({ usage: undefined }),
    () =>
      response({
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 900 },
      }),
    () =>
      response({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      }),
  ]) {
    let reservation;
    const guard = createEvaluationBudget({
      budgetUsd: 0.01,
      modelRates,
      fetchImpl: async () => {
        reservation = guard.summary().reservedUsd;
        return run();
      },
    });
    await assert.rejects(guard.fetch(endpoint, request()), (error) => {
      assert.doesNotMatch(
        `${error.stack} ${JSON.stringify(error)}`,
        /private-secret|Private evaluation prompt|Private response content/,
      );
      return true;
    });
    assert.equal(guard.summary().spentUsd, reservation);
    assert.equal(guard.summary().reservedUsd, 0);
    await assert.rejects(guard.fetch(endpoint, request()), { code: "budget" });
    assert.equal(guard.summary().calls.attempted, 1);
  }
});

test("timeouts retain cost even if ignored by transport and usage arrives later", async () => {
  let finish;
  let reservation;
  let signal;
  const guard = createEvaluationBudget({
    budgetUsd: 0.01,
    modelRates,
    timeoutMs: 10,
    fetchImpl: (_, init) => {
      reservation = guard.summary().reservedUsd;
      signal = init.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await assert.rejects(guard.fetch(endpoint, request()), { code: "timeout" });
  assert.equal(signal.aborted, true);
  finish(response());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guard.summary().spentUsd, reservation);
  assert.equal(guard.summary().reservedUsd, 0);
  assert.equal(guard.summary().calls.failed, 1);
});

test("caller cancellation is free before dispatch and retains cost after dispatch", async () => {
  const before = new AbortController();
  before.abort(new Error("private-secret"));
  const during = new AbortController();
  const guard = createEvaluationBudget({
    budgetUsd: 1,
    modelRates,
    fetchImpl: () => new Promise(() => {}),
  });
  await assert.rejects(
    guard.fetch(endpoint, request({}, { signal: before.signal })),
    { code: "cancelled" },
  );
  assert.equal(guard.summary().calls.attempted, 0);
  const pending = guard.fetch(endpoint, request({}, { signal: during.signal }));
  const reservation = guard.summary().reservedUsd;
  during.abort(new Error("private-secret"));
  await assert.rejects(pending, { code: "cancelled" });
  assert.equal(guard.summary().spentUsd, reservation);
});

test("provider token or tier violations block subsequent requests without refunding", async () => {
  for (const data of [
    { service_tier: "priority" },
    {
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1,
        total_tokens: 1_000_001,
      },
    },
    { usage: { input_tokens: 1, output_tokens: 101, total_tokens: 102 } },
  ]) {
    const guard = createEvaluationBudget({
      budgetUsd: 1,
      modelRates,
      fetchImpl: async () => response(data),
    });
    await assert.rejects(guard.fetch(endpoint, request()), {
      code: "accounting",
    });
    assert.equal(guard.summary().halted, true);
    assert.ok(guard.summary().spentUsd > 0);
    await assert.rejects(guard.fetch(endpoint, request()), { code: "halted" });
  }
});
