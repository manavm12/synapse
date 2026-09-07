import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMemoryChangeSet,
  deriveTopicProjection,
  emptyLedger,
  normalizeSourceEnvelope,
  prepareMemoryChangeSet,
  segmentsFor,
} from "../../src/memory/core/index.mjs";
import {
  createMemoryRetrievalService,
  createMemorySourceReader,
} from "../../src/server/memory-retrieval/index.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function userIdentity(ownerId = OWNER, projectId = PROJECT) {
  return { userId: ownerId, projectId };
}

function sourceEnvelope(identity, index, markdown) {
  const suffix = String(index).padStart(12, "0");
  return {
    version: 1,
    ownerId: identity.ownerId,
    projectId: identity.projectId,
    revisionId: `33333333-3333-4333-8333-${suffix}`,
    nodeId: "44444444-4444-4444-8444-444444444444",
    sessionId: `session-${index}`,
    revision: 1,
    captureId: `55555555-5555-4555-8555-${suffix}`,
    title: `Source ${index}`,
    summary: `Memory source ${index}`,
    markdown,
    capturedAt: `2026-08-${String(index).padStart(2, "0")}T10:00:00.000Z`,
  };
}

function buildFixture(identity = { ownerId: OWNER, projectId: PROJECT }) {
  let ledger = emptyLedger(identity);
  const sources = new Map();
  let index = 1;

  function append(paragraphs, claims, actions) {
    const envelope = sourceEnvelope(identity, index, paragraphs.join("\n\n"));
    const source = normalizeSourceEnvelope(envelope, identity);
    const segments = segmentsFor(source);
    assert.equal(segments.length, paragraphs.length);
    const extraction = {
      claims: claims.map((claim, claimIndex) => ({
        ref: `c${claimIndex + 1}`,
        subject: claim.subject,
        aspect: claim.aspect,
        scope: claim.scope ?? "production",
        title: claim.title,
        assertion: paragraphs[claimIndex],
        kind: claim.kind ?? "decision",
        status: claim.status ?? "active",
        topic: claim.topic,
        subtopic: claim.subtopic,
        evidence: [segments[claimIndex].id],
      })),
      coverage: segments.map((segment) => ({
        segmentId: segment.id,
        disposition: "claims",
        reason: "Supports the corresponding synthetic claim",
      })),
    };
    const changeSet = prepareMemoryChangeSet({
      ledger,
      envelope,
      expectedIdentity: identity,
      extraction,
      reconciliation: {
        actions: actions.map((action, actionIndex) => ({
          ref: `c${actionIndex + 1}`,
          action: action.action,
          targets: action.targets ?? [],
          reason: action.reason ?? "Synthetic reconciliation",
        })),
      },
      recordedAt: `2026-09-${String(index).padStart(2, "0")}T10:00:00.000Z`,
    });
    ledger = applyMemoryChangeSet(ledger, changeSet);
    sources.set(source.revisionId, source);
    index++;
    return changeSet.append.claims;
  }

  const initial = append(
    [
      "Production retains logs for 7 days.",
      "The logging runbook is docs/logging.md.",
    ],
    [
      {
        subject: "Log storage",
        aspect: "Retention",
        title: "Production retention",
        topic: "Operations",
        subtopic: "Logging",
      },
      {
        subject: "Log storage",
        aspect: "Runbook",
        scope: "unqualified",
        title: "Logging runbook",
        kind: "reference",
        topic: "Operations",
        subtopic: "Logging",
      },
    ],
    [{ action: "add" }, { action: "add" }],
  );
  const replacement = append(
    ["Production retains logs for 30 days."],
    [
      {
        subject: "Log storage",
        aspect: "Retention",
        title: "Production retention",
        kind: "change",
        topic: "Operations",
        subtopic: "Logging",
      },
    ],
    [{ action: "replaces", targets: [initial[0].id] }],
  );
  const conflict = append(
    ["A support report says production retains logs for 14 days."],
    [
      {
        subject: "Log storage",
        aspect: "Retention",
        title: "Conflicting retention report",
        topic: "Operations",
        subtopic: "Logging",
      },
    ],
    [{ action: "conflicts", targets: [replacement[0].id] }],
  );
  append(
    [
      "Membership checks use the authenticated owner identifier.",
      "Project reads also require the authenticated project identifier.",
    ],
    [
      {
        subject: "Authorization",
        aspect: "Owner isolation",
        title: "Owner-scoped reads",
        kind: "procedure",
        topic: "Security",
        subtopic: "Authorization",
      },
      {
        subject: "Authorization",
        aspect: "Project isolation",
        title: "Project-scoped reads",
        kind: "procedure",
        topic: "Security",
        subtopic: "Authorization",
      },
    ],
    [{ action: "add" }, { action: "add" }],
  );
  const standaloneHistory = append(
    ["Legacy archives use cold storage."],
    [
      {
        subject: "Archive storage",
        aspect: "Storage class",
        title: "Legacy archive",
        kind: "fact",
        status: "historical",
        topic: "Operations",
        subtopic: "Archives",
      },
    ],
    [{ action: "add" }],
  );

  const projection = deriveTopicProjection(ledger);
  const authoritative = new Map(
    [...sources].map(([revisionId, source]) => [
      revisionId,
      {
        ...source,
        ownerId: identity.ownerId,
        projectId: identity.projectId,
        revisionId,
        nodeId: source.nodeId,
        sessionId: source.sessionId,
        title: source.title,
        summary: source.summary,
        revision: source.revision,
        markdown: source.markdown,
        contentHash: source.contentHash,
        capturedAt: source.capturedAt,
      },
    ]),
  );
  const calls = [];
  const adapter = {
    async load(requested) {
      calls.push({ type: "load", ...requested });
      return { ledger, projection };
    },
  };
  const sourceReader = {
    async read(requested) {
      calls.push({ type: "read", ...requested });
      const source = authoritative.get(requested.revisionId);
      if (
        !source ||
        source.ownerId !== requested.ownerId ||
        source.projectId !== requested.projectId
      ) {
        return null;
      }
      return structuredClone(source);
    },
  };
  return {
    adapter,
    authoritative,
    calls,
    conflict,
    initial,
    ledger,
    projection,
    replacement,
    service: createMemoryRetrievalService({ adapter, sourceReader }),
    sourceReader,
    standaloneHistory,
  };
}

test("topic discovery is hierarchical, bounded, and omits note bodies and evidence", async () => {
  const fixture = buildFixture();
  const first = await fixture.service.topics(userIdentity(), { limit: 1 });
  assert.equal(first.catalog_status, "ready");
  assert.equal(first.entries.length, 1);
  assert.ok(first.next_cursor);
  assert.equal(Object.hasOwn(first.entries[0], "body"), false);
  assert.equal(Object.hasOwn(first.entries[0], "evidence"), false);

  const second = await fixture.service.topics(userIdentity(), {
    limit: 1,
    cursor: first.next_cursor,
  });
  assert.equal(second.entries.length, 1);
  assert.notEqual(second.entries[0].id, first.entries[0].id);

  const operations = fixture.projection.topics.find(
    (topic) => topic.title === "Operations",
  );
  const drilldown = await fixture.service.topics(userIdentity(), {
    topic_id: operations.id,
  });
  assert.deepEqual(
    drilldown.entries.map((entry) => entry.title),
    ["Logging"],
  );
  const logging = drilldown.entries[0];
  const notes = await fixture.service.topics(userIdentity(), {
    topic_id: logging.id,
  });
  assert.ok(notes.entries.every((entry) => entry.type === "note"));
  assert.ok(notes.entries.some((entry) => entry.conflicted));
});

test("lexical search separates current, history, and both sides of conflicts", async () => {
  const fixture = buildFixture();
  const current = await fixture.service.search(userIdentity(), {
    query: "retention",
    status: "current",
  });
  assert.ok(current.results.some((entry) => /30 days/.test(entry.assertion)));
  assert.ok(current.results.some((entry) => /14 days/.test(entry.assertion)));
  assert.ok(current.results.every((entry) => entry.status !== "superseded"));
  assert.ok(current.results.every((entry) => entry.evidence.length === 1));
  for (const result of current.results) {
    for (const evidence of result.evidence) {
      const source = fixture.authoritative.get(evidence.revision_id);
      assert.equal(
        source.markdown.slice(evidence.start, evidence.end),
        evidence.quote,
      );
    }
  }

  const history = await fixture.service.search(userIdentity(), {
    query: "retention",
    status: "historical",
  });
  assert.equal(history.results.length, 1);
  assert.equal(history.results[0].status, "superseded");
  assert.match(history.results[0].assertion, /7 days/);

  const conflicted = await fixture.service.search(userIdentity(), {
    query: "retention",
    status: "conflicted",
    evidence_limit: 0,
  });
  assert.deepEqual(
    new Set(conflicted.results.map((entry) => entry.claim_id)),
    new Set([fixture.replacement[0].id, fixture.conflict[0].id]),
  );
  assert.ok(conflicted.results.every((entry) => entry.conflicted));
  assert.ok(conflicted.results.every((entry) => entry.conflicts.length === 1));
});

test("topic filters retain standalone historical claims without projection notes", async () => {
  const fixture = buildFixture();
  const operations = fixture.projection.topics.find(
    (topic) => topic.title === "Operations",
  );
  const security = fixture.projection.topics.find(
    (topic) => topic.title === "Security",
  );
  const expectedId = fixture.standaloneHistory[0].id;
  for (const topicId of [undefined, "root", operations.id]) {
    const result = await fixture.service.search(userIdentity(), {
      query: "legacy archives",
      status: "historical",
      ...(topicId ? { topic_id: topicId } : {}),
    });
    assert.deepEqual(
      result.results.map((entry) => entry.claim_id),
      [expectedId],
    );
    assert.equal(result.results[0].note_id, null);
  }
  const unrelated = await fixture.service.search(userIdentity(), {
    query: "legacy archives",
    status: "historical",
    topic_id: security.id,
  });
  assert.deepEqual(unrelated.results, []);
});

test("claim and note reads paginate authoritative evidence and preserve history", async () => {
  const fixture = buildFixture();
  const claim = await fixture.service.read(userIdentity(), {
    target_type: "claim",
    target_id: fixture.initial[0].id,
  });
  assert.equal(claim.claim.status, "superseded");
  assert.equal(claim.claim.current, false);
  assert.equal(claim.claim.relations[0].type, "supersedes");
  assert.match(claim.evidence[0].quote, /7 days/);

  const noteId = fixture.projection.items.find((item) =>
    item.claimIds.includes(fixture.replacement[0].id),
  ).id;
  const first = await fixture.service.read(userIdentity(), {
    target_type: "note",
    target_id: noteId,
    evidence_limit: 1,
  });
  assert.match(first.note.body, /Historical, superseded \(not current\)/);
  assert.equal(first.evidence.length, 1);
  assert.ok(first.next_cursor);
  const second = await fixture.service.read(userIdentity(), {
    target_type: "note",
    target_id: noteId,
    evidence_limit: 1,
    cursor: first.next_cursor,
  });
  assert.equal(second.evidence.length, 1);
  assert.notEqual(second.evidence[0].segment_id, first.evidence[0].segment_id);
});

test("raw Markdown requires an explicit bounded source read and supports unprocessed revisions", async () => {
  const fixture = buildFixture();
  const processedId = fixture.ledger.sources[0].revisionId;
  const processed = await fixture.service.read(userIdentity(), {
    target_type: "source",
    target_id: processedId,
    max_chars: 12,
  });
  assert.equal(processed.source.processed, true);
  assert.equal(processed.source.text.length, 12);
  assert.ok(processed.next_cursor);
  const rest = await fixture.service.read(userIdentity(), {
    target_type: "source",
    target_id: processedId,
    max_chars: 4_000,
    cursor: processed.next_cursor,
  });
  assert.equal(
    processed.source.text + rest.source.text,
    fixture.authoritative.get(processedId).markdown,
  );

  const unprocessed = {
    ...fixture.authoritative.get(processedId),
    revisionId: "99999999-9999-4999-8999-999999999999",
    markdown: "Accepted but not organized.",
  };
  unprocessed.contentHash = createHash(unprocessed.markdown);
  fixture.authoritative.set(unprocessed.revisionId, unprocessed);
  const raw = await fixture.service.read(userIdentity(), {
    target_type: "source",
    target_id: unprocessed.revisionId,
  });
  assert.equal(raw.source.processed, false);
  assert.equal(raw.source.text, unprocessed.markdown);
});

function createHash(value) {
  return normalizeSourceEnvelope(
    sourceEnvelope({ ownerId: OWNER, projectId: PROJECT }, 9, value),
    { ownerId: OWNER, projectId: PROJECT },
  ).contentHash;
}

test("tenant mismatches, cursor replay, and tampered evidence fail closed", async () => {
  const first = buildFixture();
  const page = await first.service.topics(userIdentity(), { limit: 1 });
  const second = buildFixture({
    ownerId: OTHER_OWNER,
    projectId: OTHER_PROJECT,
  });
  await assert.rejects(
    second.service.topics(userIdentity(OTHER_OWNER, OTHER_PROJECT), {
      limit: 1,
      cursor: page.next_cursor,
    }),
    /cursor does not match/,
  );
  assert.deepEqual(first.calls[0], {
    type: "load",
    ownerId: OWNER,
    projectId: PROJECT,
  });

  await assert.rejects(
    first.service.topics(userIdentity(OTHER_OWNER, OTHER_PROJECT)),
    /different tenant/,
  );

  const sourceId = first.replacement[0].sourceId;
  first.authoritative.get(sourceId).markdown = "Tampered source bytes";
  await assert.rejects(
    first.service.search(userIdentity(), { query: "retention" }),
    /authoritative revision/,
  );
});

test("empty and queued snapshots are reported honestly without fabricated results", async () => {
  const ledger = emptyLedger({ ownerId: OWNER, projectId: PROJECT });
  const service = createMemoryRetrievalService({
    adapter: {
      async load() {
        return {
          ledger,
          projection: deriveTopicProjection(ledger),
          processing: { queued: 2, failed: 0 },
        };
      },
    },
  });
  const topics = await service.topics(userIdentity());
  assert.equal(topics.catalog_status, "empty");
  assert.match(topics.message, /still queued/);
  assert.deepEqual(topics.entries, []);
  const search = await service.search(userIdentity(), { query: "anything" });
  assert.deepEqual(search.results, []);
});

test("retrieval enforces input and snapshot bounds before returning content", async () => {
  const fixture = buildFixture();
  await assert.rejects(
    fixture.service.search(userIdentity(), { query: "🔥" }),
    /letter or number/,
  );
  await assert.rejects(
    fixture.service.search(userIdentity(), { query: "é".repeat(300) }),
    /512 UTF-8 bytes/,
  );
  await assert.rejects(
    fixture.service.search(userIdentity(), { query: "logs", limit: 11 }),
    /limit/,
  );
  await assert.rejects(
    fixture.service.read(userIdentity(), {
      target_type: "source",
      target_id: fixture.ledger.sources[0].revisionId,
      max_chars: 4_001,
    }),
    /max_chars/,
  );
});

test("Postgres source reader sets both trusted tenant dimensions and returns a verified row", async () => {
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes("from public.memory_revisions")) {
        return {
          rowCount: 1,
          rows: [
            {
              revision_id: "33333333-3333-4333-8333-000000000001",
              owner_id: OWNER,
              project_id: PROJECT,
              node_id: "44444444-4444-4444-8444-444444444444",
              client_session_id: "session-1",
              revision: 1,
              title: "Source",
              summary: "Summary",
              markdown: "Exact Markdown",
              capture_content_hash: "a".repeat(64),
              created_at: new Date("2026-09-01T00:00:00Z"),
            },
          ],
        };
      }
      return { rowCount: null, rows: [] };
    },
    release() {},
  };
  const reader = createMemorySourceReader({
    pool: {
      async connect() {
        return client;
      },
    },
  });
  const result = await reader.read({
    ownerId: OWNER,
    projectId: PROJECT,
    revisionId: "33333333-3333-4333-8333-000000000001",
  });
  assert.equal(result.markdown, "Exact Markdown");
  assert.equal(result.contentHash, createHash("Exact Markdown"));
  assert.deepEqual(queries[1].values, [OWNER]);
  assert.deepEqual(queries[2].values, [PROJECT]);
  assert.deepEqual(queries[3].values, [
    "33333333-3333-4333-8333-000000000001",
    OWNER,
    PROJECT,
  ]);
  assert.equal(queries.at(-1).text, "COMMIT");
});
