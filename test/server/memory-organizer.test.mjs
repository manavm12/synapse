import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyMemoryChangeSet,
  emptyLedger,
  extractionSchema,
  normalizeSourceEnvelope,
  segmentsFor,
  validateExtraction,
} from "../../src/memory/core/index.mjs";
import { validateSchema } from "../../src/memory/core/schema.mjs";
import {
  createMemoryInferenceAPI,
  MemoryInferenceError,
} from "../../src/server/memory-organizer/api.mjs";
import { extractionTransport } from "../../src/server/memory-organizer/extraction-transport.mjs";
import { createMemoryOrganizerHandler } from "../../src/server/memory-organizer/handler.mjs";
import {
  extractionRepairFeedback,
  extractionSchemaFor,
  validationReason,
} from "../../src/server/memory-organizer/validation.mjs";

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
      calls.push({ stage, data, schema, options, prompt });
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

test("extraction constrains current and earlier evidence without mutating shared schemas", async () => {
  const run = setup();
  const first = await run.handler.process(fixture.steps[0].envelope);
  await run.handler.commit({
    source: fixture.steps[0].envelope,
    result: first,
  });
  await run.handler.process(fixture.steps[1].envelope);
  const extract = run.calls.filter((call) => call.stage === "extract")[1];
  const properties = extract.schema.properties;
  assert.equal(properties.claims.items.properties.evidence.minItems, 1);
  for (const key of [
    "subject",
    "aspect",
    "scope",
    "title",
    "assertion",
    "topic",
  ]) {
    assert.equal(properties.claims.items.properties[key].pattern, "\\S");
    assert.equal(
      extractionSchema.properties.claims.items.properties[key].pattern,
      undefined,
    );
  }
  assert.equal(properties.claims.items.properties.subtopic.pattern, undefined);
  const current = extract.data.segments.map((segment) => segment.id);
  const known = [
    ...new Set([
      ...current,
      ...extract.data.contextEvidence.map((segment) => segment.id),
    ]),
  ];
  assert.deepEqual(
    properties.claims.items.properties.evidence.items.enum,
    known,
  );
  assert.deepEqual(
    properties.coverage.items.properties.segmentId.enum,
    current,
  );
  assert.equal(properties.claims.items.properties.title.enum, undefined);
  assert.equal(properties.coverage.items.properties.reason.enum, undefined);
  assert.equal(
    extractionSchema.properties.claims.items.properties.evidence.items.enum,
    undefined,
  );
  assert.equal(
    extractionSchema.properties.coverage.items.properties.segmentId.enum,
    undefined,
  );
  const foreign = structuredClone(fixture.steps[1].extraction);
  foreign.claims[0].evidence = ["foreign-segment"];
  assert.throws(
    () => validateSchema(foreign, extract.schema),
    /not an allowed value/,
  );
  foreign.claims[0].evidence = [known[0]];
  foreign.coverage[0].segmentId = extract.data.contextEvidence[0].id;
  assert.throws(
    () => validateSchema(foreign, extract.schema),
    /not an allowed value/,
  );
});

test("model claim labels cannot break deterministic refs, downstream actions or replay", async () => {
  const proposals = fixture.steps.map((step) => ({
    ...structuredClone(step.extraction),
    claims: step.extraction.claims.map((claim) => ({
      ...claim,
      ref: "duplicate-invalid-model-label",
    })),
  }));
  let extractionIndex = 0;
  const run = setup({
    respond(stage) {
      if (stage === "extract") return proposals[extractionIndex++];
      if (stage === "reconcile") return fixture.steps[1].reconciliation;
      return { issues: [] };
    },
  });
  const first = await run.handler.process(fixture.steps[0].envelope);
  assert.deepEqual(
    first.changeSet.proposal.extraction,
    fixture.steps[0].extraction,
  );
  assert.equal(first.audit.claimRefStrategy, "source-order-v1");
  assert.deepEqual(
    run.calls
      .find((call) => call.stage === "review")
      .data.extraction.claims.map((claim) => claim.ref),
    ["c1", "c2"],
  );
  await run.handler.commit({
    source: fixture.steps[0].envelope,
    result: first,
  });
  const committedClaims = structuredClone(run.ledger.claims);
  const second = await run.handler.process(fixture.steps[1].envelope);
  const reconcile = run.calls.find((call) => call.stage === "reconcile");
  assert.deepEqual(
    reconcile.data.incoming.map((claim) => claim.ref),
    fixture.steps[1].extraction.claims.map((_, index) => `c${index + 1}`),
  );
  assert.ok(
    !JSON.stringify(second.changeSet).includes("duplicate-invalid-model-label"),
  );
  await run.handler.commit({
    source: fixture.steps[1].envelope,
    result: second,
  });
  assert.deepEqual(
    run.ledger.claims.slice(0, committedClaims.length),
    committedClaims,
  );
  assert.equal(run.ledger.relations[0].type, "supersedes");
  assert.ok(
    proposals.every((proposal) =>
      proposal.claims.every(
        (claim) => claim.ref === "duplicate-invalid-model-label",
      ),
    ),
  );
});

test("deterministic labels do not repair invalid evidence or authorize stale action labels", async () => {
  const unsupported = setup({
    maxStageCalls: 1,
    respond() {
      const value = structuredClone(fixture.steps[0].extraction);
      value.claims[0].ref = "bad model label";
      value.claims[0].evidence = [];
      return value;
    },
  });
  await assert.rejects(
    unsupported.handler.process(fixture.steps[0].envelope),
    (error) => error.details.validation_reason === "evidence_unique",
  );
  assert.equal(unsupported.commits, 0);
  let committed = false;
  const stale = setup({
    maxStageCalls: 1,
    respond(stage) {
      if (stage === "review") return { issues: [] };
      if (stage === "reconcile")
        return {
          actions: fixture.steps[1].reconciliation.actions.map((action) => ({
            ...action,
            ref: "stale-model-label",
          })),
        };
      const value = structuredClone(
        fixture.steps[committed ? 1 : 0].extraction,
      );
      value.claims.forEach((claim) => {
        claim.ref = "stale-model-label";
      });
      return value;
    },
  });
  const first = await stale.handler.process(fixture.steps[0].envelope);
  await stale.handler.commit({
    source: fixture.steps[0].envelope,
    result: first,
  });
  committed = true;
  await assert.rejects(
    stale.handler.process(fixture.steps[1].envelope),
    /reconcile validation failed/,
  );
  assert.equal(stale.commits, 1);
});

test("source-specific extraction schema handles empty and bounded catalogs without truncation", () => {
  assert.deepEqual(extractionSchemaFor([], []), extractionSchema);
  const segments = segmentsFor({
    ...fixture.steps[0].envelope,
    markdown: "# First\nAlpha.\n\n# Second\nBeta.\n\nGamma.",
  });
  const schema = extractionSchemaFor(segments, [segments[0]]);
  assert.equal(
    schema.properties.coverage.items.properties.segmentId.enum.length,
    3,
  );
  assert.equal(
    schema.properties.claims.items.properties.evidence.items.enum.length,
    3,
  );
  const catalog = (n, length = 24) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(i).padStart(length, "x"),
    }));
  assert.doesNotThrow(() => extractionSchemaFor([], catalog(625)));
  assert.throws(() => extractionSchemaFor([], catalog(626)), /context limit/);
  assert.throws(
    () => extractionSchemaFor(catalog(160, 4), catalog(828, 5)),
    /context limit/,
  );
});

test("validation diagnostics expose only fixed reasons and preserve failure fencing", async () => {
  const messages = [
    ["Claim refs must be unique c1, c2, etc", "claim_refs"],
    ["Each claim needs unique evidence segment IDs", "evidence_unique"],
    ["Unknown evidence segment private source text", "evidence_unknown"],
    [
      "A new claim must cite its current source, not only previous context",
      "current_evidence_required",
    ],
    ["Unknown or duplicate coverage segment", "coverage_segments"],
    ["Coverage disposition disagrees with claim evidence", "coverage_evidence"],
    [
      "Every source segment requires a coverage disposition",
      "coverage_missing",
    ],
    ["subject must not be empty", "required_text"],
    ["private arbitrary error", "invalid_proposal"],
  ];
  for (const [message, reason] of messages)
    assert.equal(validationReason(new Error(message)), reason);
  assert.equal(validationReason(null), "invalid_proposal");
  const unsafe = new MemoryInferenceError("invalid response", {
    details: { validation_reason: "private text" },
  });
  assert.deepEqual(unsafe.details, {});
  const run = setup({
    maxStageCalls: 2,
    respond() {
      return { ...fixture.steps[0].extraction, coverage: [] };
    },
  });
  await assert.rejects(
    run.handler.process(fixture.steps[0].envelope),
    (error) => {
      assert.deepEqual(error.details, {
        inference_stage: "extract",
        validation_reason: "coverage_missing",
      });
      assert.equal(error.code, "extract validation failed");
      assert.doesNotMatch(JSON.stringify(error), /private/);
      return true;
    },
  );
  assert.equal(run.calls.length, 2);
  assert.equal(run.commits, 0);
});

test("coverage repairs identify both citation mismatches without modifying proposals", async () => {
  const original = structuredClone(fixture.steps[0].extraction);
  const bad = structuredClone(original);
  bad.coverage[0].disposition = "context";
  bad.claims.pop();
  const before = structuredClone(bad);
  const segments = segmentsFor(fixture.steps[0].envelope);
  const message = extractionRepairFeedback(
    new Error("Coverage disposition disagrees with claim evidence"),
    bad,
    segments,
  );
  const issues = JSON.parse(
    message.split("Coverage consistency issues: ")[1].split("\n")[0],
  );
  assert.deepEqual(issues, [
    {
      segmentId: original.coverage[0].segmentId,
      coverageEntries: 1,
      citingRefs: ["c1"],
      dispositions: ["context"],
    },
    {
      segmentId: original.coverage[1].segmentId,
      coverageEntries: 1,
      citingRefs: [],
      dispositions: ["claims"],
    },
  ]);
  assert.deepEqual(bad, before);
  assert.match(message, /Never add an unsupported citation/);
  const run = setup({
    maxStageCalls: 2,
    respond(stage, _data, calls) {
      if (stage === "review") return { issues: [] };
      return calls.filter((call) => call.stage === "extract").length === 1
        ? bad
        : original;
    },
  });
  const result = await run.handler.process(fixture.steps[0].envelope);
  assert.match(run.calls[1].prompt, /Coverage consistency issues:/);
  assert.ok(run.calls[1].prompt.includes(message));
  assert.deepEqual(result.changeSet.proposal.extraction, original);
  assert.deepEqual(result.audit.stageCalls, {
    extract: 2,
    reconcile: 0,
    review: 1,
  });
  assert.equal(run.commits, 0);
});

test("coverage feedback identifies missing and duplicate current entries, not foreign text", () => {
  const segments = segmentsFor(fixture.steps[0].envelope);
  const bad = structuredClone(fixture.steps[0].extraction);
  bad.coverage[1] = structuredClone(bad.coverage[0]);
  const feedback = extractionRepairFeedback(
    new Error("Unknown or duplicate coverage segment"),
    bad,
    segments,
  );
  assert.match(feedback, /"coverageEntries":2/);
  assert.match(feedback, /"coverageEntries":0/);
  assert.ok(feedback.includes(segments[1].id));
  assert.equal(
    extractionRepairFeedback(new Error("Other failure"), bad, segments),
    "Other failure",
  );
  assert.equal(
    extractionRepairFeedback(
      new Error("Every source segment requires a coverage disposition"),
      undefined,
      segments,
    ),
    "Every source segment requires a coverage disposition",
  );
});

test("persistent coverage mismatches still fail closed with safe errors and no review or commit", async () => {
  const run = setup({
    maxStageCalls: 2,
    respond() {
      const bad = structuredClone(fixture.steps[0].extraction);
      bad.coverage[0].disposition = "context";
      return bad;
    },
  });
  await assert.rejects(
    run.handler.process(fixture.steps[0].envelope),
    (error) => {
      assert.deepEqual(error.details, {
        inference_stage: "extract",
        validation_reason: "coverage_evidence",
      });
      assert.doesNotMatch(
        JSON.stringify(error),
        /seg:|citingRefs|Coverage consistency issues/,
      );
      return true;
    },
  );
  assert.equal(run.calls.length, 2);
  assert.equal(run.commits, 0);
});

test("one repair identifies empty, duplicate, and context-only claim evidence alongside coverage", () => {
  const bad = structuredClone(fixture.steps[0].extraction);
  bad.claims[0].evidence = [];
  bad.claims[1].evidence = ["earlier-context", "earlier-context"];
  const feedback = extractionRepairFeedback(
    new Error("Each claim needs unique evidence segment IDs"),
    bad,
    segmentsFor(fixture.steps[0].envelope),
  );
  const issues = JSON.parse(
    feedback.split("Evidence consistency issues: ")[1].split("\n")[0],
  );
  assert.deepEqual(issues, [
    { ref: "c1", empty: true, duplicate: false, currentMissing: true },
    { ref: "c2", empty: false, duplicate: true, currentMissing: true },
  ]);
  assert.match(feedback, /Coverage consistency issues:/);
  assert.doesNotMatch(feedback, /earlier-context/);
});

test("required-text repair names empty metadata fields and incomplete coverage reasons", () => {
  const bad = structuredClone(fixture.steps[0].extraction);
  bad.claims[0].scope = " ";
  bad.claims[1].topic = "";
  bad.claims[1].title = "";
  bad.coverage[0].reason = "";
  const feedback = extractionRepairFeedback(
    new Error("scope must not be empty"),
    bad,
    segmentsFor(fixture.steps[0].envelope),
  );
  const issues = JSON.parse(
    feedback.split("Required text issues: ")[1].split("\n")[0],
  );
  assert.deepEqual(issues, [
    { ref: "c1", fields: ["scope"] },
    { ref: "c2", fields: ["title", "topic"] },
  ]);
  assert.ok(feedback.includes(bad.coverage[0].segmentId));
  assert.match(feedback, /Use unqualified/);
  assert.throws(
    () =>
      validateExtraction(
        fixture.steps[0].envelope,
        bad,
        emptyLedger(fixture.identity),
      ),
    /scope must not be empty/,
  );
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

test("mixed repairs can use every stage allowance without increasing any call budget", async () => {
  let processingSecond = false;
  const counts = { extract: 0, reconcile: 0, review: 0 };
  const run = setup({
    maxStageCalls: 2,
    respond(stage) {
      if (!processingSecond)
        return stage === "extract"
          ? structuredClone(fixture.steps[0].extraction)
          : { issues: [] };
      counts[stage]++;
      if (stage === "extract") {
        const value = structuredClone(fixture.steps[1].extraction);
        if (counts.extract === 1) value.coverage = [];
        return value;
      }
      if (stage === "reconcile")
        return structuredClone(fixture.steps[1].reconciliation);
      return {
        issues:
          counts.review === 1
            ? [
                {
                  stage: "reconciliation",
                  ref: "c1",
                  detail: "Synthetic repair",
                },
              ]
            : [],
      };
    },
  });
  await run.handler.commit({
    result: await run.handler.process(fixture.steps[0].envelope),
  });
  processingSecond = true;
  const result = await run.handler.process(fixture.steps[1].envelope);
  assert.deepEqual(result.audit.stageCalls, {
    extract: 2,
    reconcile: 2,
    review: 2,
  });
  assert.equal(result.audit.calls.length, 6);
  assert.equal(result.audit.maxStageCalls, 2);
  assert.equal(result.audit.reviewPassed, true);
  assert.equal(run.commits, 1, "processing alone must not commit the repair");
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

function groupedFixture() {
  const flat = fixture.steps[0].extraction;
  return {
    segments: Object.fromEntries(
      flat.coverage.map((entry) => [
        entry.segmentId,
        {
          claims: flat.claims
            .filter((claim) => claim.evidence[0] === entry.segmentId)
            .map(({ ref: _ref, evidence, ...claim }) => ({
              ...claim,
              additionalEvidence: evidence.slice(1),
            })),
        },
      ]),
    ),
  };
}

test("grouped extraction derives current evidence, stable refs and complete coverage", () => {
  const source = fixture.steps[0].envelope;
  const schema = extractionSchemaFor(segmentsFor(source), []);
  const before = structuredClone(schema);
  const transport = extractionTransport(schema);
  const grouped = groupedFixture();
  const reversed = {
    segments: Object.fromEntries(Object.entries(grouped.segments).reverse()),
  };
  const flat = transport.decode(grouped);
  assert.deepEqual(transport.decode(reversed), flat);
  assert.deepEqual(flat.claims, fixture.steps[0].extraction.claims);
  validateExtraction(source, flat, emptyLedger(fixture.identity));
  assert.deepEqual(schema, before);
  assert.ok(
    Object.values(transport.schema.properties.segments.properties).every(
      (item) => item.$ref === "#/$defs/group",
    ),
  );
  assert.equal(transport.schema.$defs.claim.properties.ref, undefined);
  assert.equal(transport.schema.$defs.claim.properties.evidence, undefined);
  assert.deepEqual(
    transport.schema.$defs.claim.properties.additionalEvidence.items.enum,
    schema.properties.claims.items.properties.evidence.items.enum,
  );
  assert.equal(extractionTransport(extractionSchema), null);
});

test("cross-segment context and repeated evidence cannot contradict derived coverage", () => {
  const source = fixture.steps[0].envelope;
  const schema = extractionSchemaFor(segmentsFor(source), [{ id: "earlier" }]);
  const transport = extractionTransport(schema);
  const grouped = groupedFixture();
  const [first, second] = Object.keys(grouped.segments);
  grouped.segments[first].claims[0].additionalEvidence = [
    first,
    second,
    second,
    "earlier",
  ];
  grouped.segments[second] = {
    nonClaimDisposition: "context",
    nonClaimReason: "Context for the first group",
  };
  const before = structuredClone(grouped);
  const flat = transport.decode(grouped);
  assert.deepEqual(flat.claims[0].evidence, [first, second, "earlier"]);
  assert.ok(flat.coverage.every((entry) => entry.disposition === "claims"));
  assert.deepEqual(grouped, before);
  grouped.segments[first] = {
    nonClaimDisposition: "boilerplate",
    nonClaimReason: "No assertions",
  };
  const empty = transport.decode(grouped);
  assert.equal(empty.claims.length, 0);
  assert.deepEqual(
    empty.coverage.map((entry) => entry.disposition),
    ["boilerplate", "context"],
  );
  assert.equal(empty.coverage[1].reason, "Context for the first group");
});

test("grouped transport rejects missing/foreign groups, foreign evidence and excess total claims", () => {
  const transport = extractionTransport(
    extractionSchemaFor(segmentsFor(fixture.steps[0].envelope), []),
  );
  const [first, second] = Object.keys(groupedFixture().segments);
  for (const mutate of [
    (value) => {
      delete value.segments[first];
    },
    (value) => {
      value.segments.foreign = value.segments[first];
    },
    (value) => {
      value.segments[first].claims[0].additionalEvidence = ["foreign"];
    },
    (value) => {
      value.segments[first].nonClaimDisposition = "claims";
    },
    (value) => {
      value.segments[first].claims = [];
    },
    (value) => {
      value.segments[first].claims[0].additionalEvidence = null;
    },
    (value) => {
      value.segments[first].claims = Array(101).fill(
        value.segments[first].claims[0],
      );
      value.segments[second].claims = Array(100).fill(
        value.segments[second].claims[0],
      );
    },
  ]) {
    const value = groupedFixture();
    mutate(value);
    assert.throws(() => transport.decode(value));
  }
});

test("real API uses compact grouped provider schema and returns the flat handler contract", async () => {
  let body;
  const api = createMemoryInferenceAPI({
    ...apiOptions,
    fetcher: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json(rawResponse(groupedFixture()));
    },
  });
  const schema = extractionSchemaFor(
    segmentsFor(fixture.steps[0].envelope),
    [],
  );
  const result = await api.structured(
    "extract",
    "Synthetic grouped prompt",
    schema,
  );
  assert.ok(body.text.format.schema.$defs);
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(result.value.claims, fixture.steps[0].extraction.claims);
  assert.equal(api.extractionFormat, "source-groups-v1");
  validateExtraction(
    fixture.steps[0].envelope,
    result.value,
    emptyLedger(fixture.identity),
  );
});

test("derived coverage does not bypass semantic review for omitted or unsupported claims", async () => {
  for (const omit of [true, false]) {
    const grouped = groupedFixture();
    const first = Object.keys(grouped.segments)[0];
    if (omit) {
      grouped.segments[first] = {
        nonClaimDisposition: "context",
        nonClaimReason: "Model incorrectly judged no durable facts",
      };
    } else
      grouped.segments[first].claims[0].assertion =
        "Unsupported synthetic assertion";
    let reviews = 0;
    let commits = 0;
    const api = createMemoryInferenceAPI({
      ...apiOptions,
      fetcher: async (_url, options) => {
        const request = JSON.parse(options.body);
        if (request.text.format.name === "memory_extract")
          return Response.json(rawResponse(grouped));
        reviews++;
        return Response.json(
          rawResponse({
            issues: [
              {
                stage: "extraction",
                ref: "c1",
                detail: omit
                  ? "Lost retention decision"
                  : "Unsupported assertion",
              },
            ],
          }),
        );
      },
    });
    const handler = createMemoryOrganizerHandler({
      api,
      maxStageCalls: 1,
      adapter: {
        async loadSource(source) {
          return {
            source: normalizeSourceEnvelope(source, fixture.identity),
            ledger: emptyLedger(fixture.identity),
          };
        },
        async commit() {
          commits++;
        },
      },
    });
    await assert.rejects(
      handler.process(fixture.steps[0].envelope),
      /semantic review rejected/,
    );
    assert.equal(reviews, 1);
    assert.equal(commits, 0);
  }
});

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
