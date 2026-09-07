import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  applyMemoryChangeSet,
  currentClaims,
  deriveTopicProjection,
  emptyLedger,
  normalizeSourceEnvelope,
  prepareMemoryChangeSet,
  segmentsFor,
  validateExtraction,
  validateLedger,
} from "../../src/memory/core/index.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../fixtures/memory-core/log-retention.json", import.meta.url),
    "utf8",
  ),
);
const recordedAt = "2026-09-07T01:00:00.000Z";

function prepare(ledger, step) {
  return prepareMemoryChangeSet({
    ledger,
    envelope: step.envelope,
    expectedIdentity: fixture.identity,
    extraction: step.extraction,
    reconciliation: step.reconciliation,
    recordedAt,
  });
}

test("v1 source normalization enforces trusted tenant/project identity and preserves bytes and offsets", () => {
  const envelope = {
    ...fixture.steps[0].envelope,
    markdown:
      "---\r\nnote: café\r\n---\r\n# Summary\r\nUnicode café\r\nsecond line\r\n\r\n```md\r\n## not a heading\r\n\r\ncode\r\n```",
  };
  const source = normalizeSourceEnvelope(envelope, fixture.identity);
  assert.equal(source.markdown, envelope.markdown);
  const segments = segmentsFor(source);
  assert.equal(segments[0].section, "Summary");
  assert.ok(
    segments.some((segment) => segment.text.includes("## not a heading")),
  );
  assert.ok(
    segments.every(
      (segment) =>
        source.markdown.slice(segment.start, segment.end) === segment.text,
    ),
  );

  assert.throws(
    () =>
      normalizeSourceEnvelope(
        { ...envelope, ownerId: envelope.projectId },
        fixture.identity,
      ),
    /owner does not match/,
  );
  assert.throws(
    () =>
      normalizeSourceEnvelope(
        { ...envelope, projectId: envelope.ownerId },
        fixture.identity,
      ),
    /project does not match/,
  );
  assert.throws(
    () =>
      normalizeSourceEnvelope(
        { ...envelope, revisionId: "session-alias" },
        fixture.identity,
      ),
    /revisionId must be a UUID/,
  );
  assert.throws(
    () => emptyLedger({ ownerId: "alias", projectId: envelope.projectId }),
    /Ledger identity.ownerId must be a UUID/,
  );
});

test("supplied proposals preserve evidence, scope, immutable history and explicit replacement", () => {
  const initial = emptyLedger(fixture.identity);
  const firstChange = prepare(initial, fixture.steps[0]);
  const first = applyMemoryChangeSet(initial, firstChange);
  const original = structuredClone(first.claims);
  const secondChange = prepare(first, fixture.steps[1]);
  const second = applyMemoryChangeSet(first, secondChange);

  assert.deepEqual(second.claims.slice(0, original.length), original);
  assert.equal(
    currentClaims(second).find((claim) => claim.aspect === "retention")
      .assertion,
    "Production retains logs for 30 days.",
  );
  assert.ok(currentClaims(second).some((claim) => claim.aspect === "runbook"));
  assert.equal(
    second.claims[0].evidence[0].quote,
    "Production retains logs for 7 days.",
  );
  assert.equal(
    second.claims[0].evidence[0].documentId,
    fixture.steps[0].envelope.revisionId,
  );
  assert.ok(validateLedger(second));
  assert.ok(
    secondChange.projection.items.some((item) =>
      item.versions[0].body.includes("Historical, superseded"),
    ),
  );
});

test("scope, evidence coverage and chronology checks reject unsafe proposals", () => {
  const first = applyMemoryChangeSet(
    emptyLedger(fixture.identity),
    prepare(emptyLedger(fixture.identity), fixture.steps[0]),
  );
  const unsafeScope = structuredClone(fixture.steps[1]);
  unsafeScope.extraction.claims[0].scope = "staging";
  assert.throws(() => prepare(first, unsafeScope), /across scopes/);

  const missingEvidence = structuredClone(fixture.steps[1]);
  missingEvidence.extraction.claims[0].evidence = [];
  assert.throws(() => prepare(first, missingEvidence), /evidence/);

  const backwards = structuredClone(fixture.steps[1]);
  backwards.envelope.capturedAt = "2026-07-01T10:00:00.000Z";
  assert.throws(() => prepare(first, backwards), /older source/);

  const incomplete = structuredClone(fixture.steps[1]);
  incomplete.extraction.coverage = [];
  const source = normalizeSourceEnvelope(incomplete.envelope, fixture.identity);
  assert.throws(
    () => validateExtraction(source, incomplete.extraction, first),
    /Every source segment/,
  );
});

test("change sets replay deterministically and reject stale or altered projections", () => {
  const initial = emptyLedger(fixture.identity);
  const changes = [];
  let preparedAgainst = initial;
  for (const step of fixture.steps) {
    const change = prepare(preparedAgainst, step);
    changes.push(change);
    preparedAgainst = applyMemoryChangeSet(preparedAgainst, change);
  }
  let replayed = emptyLedger(fixture.identity);
  for (const change of changes)
    replayed = applyMemoryChangeSet(replayed, change);
  assert.deepEqual(replayed, preparedAgainst);
  assert.deepEqual(deriveTopicProjection(replayed), changes.at(-1).projection);
  assert.throws(() => applyMemoryChangeSet(replayed, changes[0]), /stale/);

  const altered = structuredClone(changes[0]);
  altered.projection.topics[0].title = "Tampered";
  assert.throws(
    () => applyMemoryChangeSet(initial, altered),
    /does not replay deterministically/,
  );

  const alteredSource = structuredClone(changes[0]);
  alteredSource.source.markdown += "\nInjected";
  assert.throws(
    () => applyMemoryChangeSet(initial, alteredSource),
    /source bytes/,
  );

  const alteredMetadata = structuredClone(changes[0]);
  alteredMetadata.append.sources[0].sessionId = "different-session";
  assert.throws(
    () => applyMemoryChangeSet(initial, alteredMetadata),
    /source metadata is inconsistent/,
  );
});

test("topic projection is bounded, deterministic, scoped, and leaves the ledger untouched", () => {
  const step = structuredClone(fixture.steps[0]);
  step.extraction.claims = Array.from({ length: 19 }, (_, index) => ({
    ...step.extraction.claims[0],
    ref: `c${index + 1}`,
    subject: `component ${index}`,
    aspect: `setting-${index}`,
    scope: index === 18 ? "staging" : "production",
    title: `Setting ${index}`,
    assertion: `Protocol setting ${index} is enabled.`,
  }));
  step.extraction.coverage = [
    {
      segmentId: step.extraction.claims[0].evidence[0],
      disposition: "claims",
      reason: "Synthetic bundled claims",
    },
    {
      segmentId: fixture.steps[0].extraction.coverage[1].segmentId,
      disposition: "context",
      reason: "Fixture reference unused here",
    },
  ];
  step.reconciliation.actions = step.extraction.claims.map((claim) => ({
    ref: claim.ref,
    action: "add",
    targets: [],
    reason: "Synthetic new setting",
  }));
  const ledger = applyMemoryChangeSet(
    emptyLedger(fixture.identity),
    prepare(emptyLedger(fixture.identity), step),
  );
  const before = JSON.stringify(ledger);
  const projection = deriveTopicProjection(ledger);
  assert.equal(projection.items.length, 4);
  assert.ok(projection.items.every((item) => item.claimIds.length <= 8));
  assert.equal(projection.items.flatMap((item) => item.claimIds).length, 19);
  assert.equal(
    projection.items.filter((item) =>
      item.versions[0].title.includes("staging"),
    ).length,
    1,
  );
  assert.deepEqual(deriveTopicProjection(ledger), projection);
  assert.equal(JSON.stringify(ledger), before);
});
