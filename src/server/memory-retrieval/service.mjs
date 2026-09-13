import { createHash } from "node:crypto";

import { currentClaims, validateLedger } from "../../memory/core/index.mjs";

const MAX_QUERY_BYTES = 512;
const MAX_CURSOR_BYTES = 512;
const MAX_EVIDENCE_QUOTE = 1_000;
const MAX_NOTE_BODY = 8_000;
const MAX_ASSERTION = 1_000;
const MAX_RELATIONS = 12;
const MAX_TITLE = 500;
const MAX_LABEL = 300;
const MAX_SUMMARY = 1_000;
const CURRENT_STATES = new Set(["active", "disputed", "resolved"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MemoryNotFoundError extends Error {
  constructor(message = "The requested memory record was not found") {
    super(message);
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryRetrievalUnavailableError extends Error {
  constructor(message = "Memory retrieval is temporarily unavailable") {
    super(message);
    this.name = "MemoryRetrievalUnavailableError";
  }
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return candidate;
}

function boundedText(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must contain 1..${maximum} characters`);
  }
  return value.trim();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value, maximum) {
  if (value.length <= maximum) return { value, truncated: false };
  // JSONB rejects a half-surrogate. Keep exact UTF-16 offsets while cutting
  // before an emoji/pair instead of manufacturing a replacement character.
  const end = /[\uD800-\uDBFF]/u.test(value[maximum - 1])
    ? maximum - 1
    : maximum;
  return { value: value.slice(0, end), truncated: true };
}

function scopeDigest(value) {
  return digest(JSON.stringify(value)).slice(0, 24);
}

function encodeCursor({ kind, generation, offset, scope }) {
  return Buffer.from(
    JSON.stringify({ version: 1, kind, generation, offset, scope }),
  ).toString("base64url");
}

function cursorOffset(cursor, expected) {
  if (cursor === undefined || cursor === null) return 0;
  if (
    typeof cursor !== "string" ||
    !cursor ||
    Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES
  ) {
    throw new Error("cursor is invalid");
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      parsed.version !== 1 ||
      parsed.kind !== expected.kind ||
      parsed.generation !== expected.generation ||
      parsed.scope !== expected.scope ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error("cursor does not match this memory view");
    }
    return parsed.offset;
  } catch (error) {
    if (error?.message === "cursor does not match this memory view")
      throw error;
    throw new Error("cursor is invalid");
  }
}

function nextCursor(entries, offset, limit, descriptor) {
  if (offset + limit >= entries.length) return null;
  return encodeCursor({ ...descriptor, offset: offset + limit });
}

function verifySnapshot(snapshot, identity) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new MemoryRetrievalUnavailableError();
  }
  const { ledger, projection } = snapshot;
  validateLedger(ledger);
  if (
    ledger.ownerId !== identity.ownerId ||
    ledger.projectId !== identity.projectId
  ) {
    throw new Error("Memory adapter returned a different tenant snapshot");
  }
  if (
    !projection ||
    !Array.isArray(projection.topics) ||
    !Array.isArray(projection.items) ||
    !Array.isArray(projection.edges)
  ) {
    throw new Error("Memory adapter returned an invalid topic projection");
  }
  const projectionGeneration =
    projection.ledgerVersion ?? projection.generation ?? projection.version;
  if (projectionGeneration !== ledger.version) {
    throw new Error("Memory adapter returned a stale topic projection");
  }
  if (
    ledger.claims.length > 100_000 ||
    projection.topics.length > 20_000 ||
    projection.items.length > 100_000
  ) {
    throw new Error("Memory snapshot exceeds retrieval safety bounds");
  }
  const claimIds = new Set(ledger.claims.map((claim) => claim.id));
  const topicIds = new Set(projection.topics.map((topic) => topic.id));
  if (topicIds.size !== projection.topics.length) {
    throw new Error("Memory projection contains duplicate topics");
  }
  for (const topic of projection.topics) {
    if (
      typeof topic.id !== "string" ||
      typeof topic.title !== "string" ||
      (topic.id !== "root" && !topicIds.has(topic.parentId))
    ) {
      throw new Error("Memory projection contains an invalid topic");
    }
  }
  const noteIds = new Set();
  for (const item of projection.items) {
    if (
      typeof item.id !== "string" ||
      noteIds.has(item.id) ||
      !topicIds.has(item.primary) ||
      !Array.isArray(item.claimIds) ||
      item.claimIds.length > 8 ||
      item.claimIds.some((id) => !claimIds.has(id)) ||
      !Array.isArray(item.versions) ||
      item.versions.length < 1
    ) {
      throw new Error("Memory projection contains an invalid note");
    }
    noteIds.add(item.id);
  }
  const sources = new Set(ledger.sources.map((source) => source.revisionId));
  for (const claim of ledger.claims) {
    for (const evidence of claim.evidence) {
      if (!sources.has(evidence.documentId)) {
        throw new Error("Memory evidence cites an unknown revision");
      }
    }
  }
  return { ledger, projection, processing: snapshot.processing ?? null };
}

function catalogEnvelope(ledger, processing) {
  if (ledger.version > 0) {
    return { catalog_status: "ready", generation: ledger.version };
  }
  const queued = Number.isSafeInteger(processing?.queued)
    ? Math.max(0, processing.queued)
    : null;
  const failed = Number.isSafeInteger(processing?.failed)
    ? Math.max(0, processing.failed)
    : null;
  return {
    catalog_status: "empty",
    generation: 0,
    message:
      queued && queued > 0
        ? "No processed memory is available yet; accepted revisions are still queued."
        : failed && failed > 0
          ? "No processed memory is available; at least one accepted revision failed processing."
          : "No processed memory is available. Accepted revisions may be absent or not processed yet.",
  };
}

function latestVersion(item) {
  return item.versions.at(-1);
}

function relationIndex(ledger) {
  const relations = new Map();
  const conflicted = new Set();
  for (const relation of ledger.relations) {
    for (const id of [relation.from, relation.to]) {
      if (!relations.has(id)) relations.set(id, []);
      relations.get(id).push(relation);
    }
    if (relation.type === "conflicts") {
      conflicted.add(relation.from);
      conflicted.add(relation.to);
    }
  }
  return { relations, conflicted };
}

function claimView(ledger, projection) {
  const claims = currentClaims(ledger, { includeHistory: true });
  const notesByClaim = new Map();
  for (const item of projection.items) {
    for (const claimId of item.claimIds) notesByClaim.set(claimId, item.id);
  }
  for (const claim of claims) {
    if (!notesByClaim.has(claim.id) && notesByClaim.has(claim.canonicalId)) {
      notesByClaim.set(claim.id, notesByClaim.get(claim.canonicalId));
    }
  }
  return { claims, notesByClaim };
}

function topicDescendants(projection, topicId) {
  const allowed = new Set([topicId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const topic of projection.topics) {
      if (allowed.has(topic.parentId) && !allowed.has(topic.id)) {
        allowed.add(topic.id);
        changed = true;
      }
    }
  }
  return allowed;
}

function claimMatchesTopicLabels(claim, topicId, projection) {
  if (topicId === "root") return true;
  const topic = projection.topics.find((entry) => entry.id === topicId);
  if (!topic) return false;
  if (topic.parentId === "root") {
    return normalized(claim.topic) === normalized(topic.title);
  }
  const parent = projection.topics.find((entry) => entry.id === topic.parentId);
  return (
    parent &&
    normalized(claim.topic) === normalized(parent.title) &&
    normalized(claim.subtopic) === normalized(topic.title)
  );
}

function evidenceCitation(evidence, sources) {
  const source = sources.get(evidence.documentId);
  if (!source) throw new Error("Memory evidence cites an unknown revision");
  const quote = truncate(evidence.quote, MAX_EVIDENCE_QUOTE).value;
  return {
    revision_id: evidence.documentId,
    source_revision: source.revision,
    segment_id: evidence.segmentId,
    start: evidence.start,
    end: evidence.start + quote.length,
    segment_start: evidence.start,
    segment_end: evidence.end,
    quote,
    quote_truncated: quote.length !== evidence.quote.length,
    content_hash: source.contentHash,
    captured_at: source.capturedAt,
  };
}

async function evidencePage(
  entries,
  sources,
  cursor,
  limit,
  descriptor,
  verifyEvidence,
) {
  const unique = [
    ...new Map(entries.map((entry) => [entry.segmentId, entry])).values(),
  ];
  const offset = cursorOffset(cursor, descriptor);
  const selected = unique.slice(offset, offset + limit);
  await verifyEvidence(selected);
  return {
    evidence: selected.map((entry) => evidenceCitation(entry, sources)),
    next_cursor: nextCursor(unique, offset, limit, descriptor),
  };
}

function normalized(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function queryTerms(query) {
  const terms = [
    ...new Set(
      normalized(query).match(/[\p{L}\p{N}][\p{L}\p{N}._:/-]*/gu) ?? [],
    ),
  ];
  if (terms.length === 0) {
    throw new Error("query must contain at least one letter or number");
  }
  return terms.slice(0, 16);
}

function lexicalScore(claim, state, query, terms) {
  const fields = [
    [claim.assertion, 9],
    [claim.title, 7],
    [claim.subject, 5],
    [claim.aspect, 5],
    [claim.scope, 4],
    [claim.topic, 4],
    [claim.subtopic, 3],
    [claim.kind, 2],
    [state, 2],
  ];
  const phrase = normalized(query);
  let score = 0;
  for (const [raw, weight] of fields) {
    const text = normalized(raw ?? "");
    if (text.includes(phrase)) score += weight * 5;
    for (const term of terms) {
      if (text === term) score += weight * 3;
      else if (text.includes(term)) score += weight;
    }
  }
  return score;
}

function relationSummary(relation, claimId, claimsById) {
  const otherId = relation.from === claimId ? relation.to : relation.from;
  const other = claimsById.get(otherId);
  return {
    type: relation.type,
    direction: relation.from === claimId ? "outgoing" : "incoming",
    claim_id: otherId,
    claim_status: other?.state ?? null,
    reason: truncate(relation.reason, 500).value,
  };
}

function readDescriptor(kind, generation, targetId, identity) {
  return {
    kind,
    generation,
    scope: scopeDigest({
      ownerId: identity.userId,
      projectId: identity.projectId,
      targetId,
    }),
  };
}

export function createMemoryRetrievalService({ adapter, sourceReader = null }) {
  if (!adapter || typeof adapter.load !== "function") {
    throw new TypeError("A memory ledger adapter with load() is required");
  }

  async function load(identity) {
    const trusted = { ownerId: identity.userId, projectId: identity.projectId };
    return verifySnapshot(await adapter.load(trusted), trusted);
  }

  async function verifyEvidence(identity, entries, sources) {
    if (entries.length === 0) return;
    if (!sourceReader || typeof sourceReader.read !== "function") {
      throw new MemoryRetrievalUnavailableError(
        "Authoritative evidence verification is not configured",
      );
    }
    const revisionIds = [...new Set(entries.map((entry) => entry.documentId))];
    const revisions = new Map(
      await Promise.all(
        revisionIds.map(async (revisionId) => {
          const source = await sourceReader.read({
            ownerId: identity.userId,
            projectId: identity.projectId,
            revisionId,
          });
          const ledgerSource = sources.get(revisionId);
          if (
            !source ||
            !ledgerSource ||
            source.ownerId !== identity.userId ||
            source.projectId !== identity.projectId ||
            source.revisionId !== revisionId ||
            typeof source.markdown !== "string" ||
            digest(source.markdown) !== ledgerSource.contentHash
          ) {
            throw new Error(
              "Memory evidence could not be verified against its authoritative revision",
            );
          }
          return [revisionId, source];
        }),
      ),
    );
    for (const entry of entries) {
      const source = revisions.get(entry.documentId);
      if (source.markdown.slice(entry.start, entry.end) !== entry.quote) {
        throw new Error(
          "Memory evidence quote does not match its authoritative revision",
        );
      }
    }
  }

  async function topics(identity, input = {}) {
    const { ledger, projection, processing } = await load(identity);
    const envelope = catalogEnvelope(ledger, processing);
    if (envelope.catalog_status === "empty") {
      return { ...envelope, topic: null, entries: [], next_cursor: null };
    }
    const topicId = input.topic_id ?? "root";
    const topic = projection.topics.find((entry) => entry.id === topicId);
    if (!topic) throw new MemoryNotFoundError("Memory topic was not found");
    const limit = boundedInteger(input.limit, 10, 1, 20, "limit");
    const { conflicted } = relationIndex(ledger);
    const entries = [
      ...projection.topics
        .filter((entry) => entry.parentId === topicId)
        .map((entry) => ({
          type: "topic",
          id: entry.id,
          title: truncate(entry.title, MAX_TITLE).value,
          summary: truncate(entry.summary, MAX_SUMMARY).value,
          child_topic_count: projection.topics.filter(
            (candidate) => candidate.parentId === entry.id,
          ).length,
          direct_note_count: projection.items.filter(
            (candidate) => candidate.primary === entry.id,
          ).length,
        })),
      ...projection.items
        .filter((item) => item.primary === topicId)
        .map((item) => {
          const version = latestVersion(item);
          return {
            type: "note",
            id: item.id,
            title: truncate(version.title, MAX_TITLE).value,
            kind: item.kind,
            status: version.status,
            conflicted: item.claimIds.some((id) => conflicted.has(id)),
            observed_at: version.observedAt,
          };
        }),
    ];
    const descriptor = {
      kind: "topics",
      generation: ledger.version,
      scope: scopeDigest({
        ownerId: identity.userId,
        projectId: identity.projectId,
        topicId,
      }),
    };
    const offset = cursorOffset(input.cursor, descriptor);
    return {
      ...envelope,
      topic: {
        id: topic.id,
        title: truncate(topic.title, MAX_TITLE).value,
        summary: truncate(topic.summary, MAX_SUMMARY).value,
        parent_id: topic.parentId || null,
      },
      entries: entries.slice(offset, offset + limit),
      next_cursor: nextCursor(entries, offset, limit, descriptor),
    };
  }

  async function search(identity, input) {
    const query = boundedText(input?.query, 500, "query");
    if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
      throw new Error("query must be at most 512 UTF-8 bytes");
    }
    const terms = queryTerms(query);
    const status = input.status ?? "current";
    if (!["current", "historical", "conflicted", "all"].includes(status)) {
      throw new Error("status is invalid");
    }
    const limit = boundedInteger(input.limit, 5, 1, 10, "limit");
    const evidenceLimit = boundedInteger(
      input.evidence_limit,
      2,
      0,
      3,
      "evidence_limit",
    );
    const { ledger, projection, processing } = await load(identity);
    const envelope = catalogEnvelope(ledger, processing);
    if (envelope.catalog_status === "empty") {
      return {
        ...envelope,
        query,
        status,
        results: [],
        next_cursor: null,
      };
    }
    const { claims, notesByClaim } = claimView(ledger, projection);
    const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
    const { relations, conflicted } = relationIndex(ledger);
    let topicFilter = null;
    if (input.topic_id !== undefined) {
      const topicId = boundedText(input.topic_id, 128, "topic_id");
      if (!projection.topics.some((topic) => topic.id === topicId)) {
        throw new MemoryNotFoundError("Memory topic was not found");
      }
      const descendants = topicDescendants(projection, topicId);
      topicFilter = {
        topicId,
        allowedNotes: new Set(
          projection.items
            .filter((item) => descendants.has(item.primary))
            .map((item) => item.id),
        ),
      };
    }
    const sources = new Map(
      ledger.sources.map((source) => [source.revisionId, source]),
    );
    const candidates = claims
      .filter((claim) => {
        const isCurrent = CURRENT_STATES.has(claim.state);
        if (status === "current" && !isCurrent) return false;
        if (status === "historical" && isCurrent) return false;
        if (status === "conflicted" && !conflicted.has(claim.id)) return false;
        if (topicFilter) {
          const projected = topicFilter.allowedNotes.has(
            notesByClaim.get(claim.id),
          );
          if (
            !projected &&
            !claimMatchesTopicLabels(claim, topicFilter.topicId, projection)
          ) {
            return false;
          }
        }
        return true;
      })
      .map((claim) => ({
        claim,
        score: lexicalScore(claim, claim.state, query, terms),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.claim.id.localeCompare(right.claim.id),
      );
    const scope = scopeDigest({
      ownerId: identity.userId,
      projectId: identity.projectId,
      query,
      status,
      topicId: input.topic_id ?? null,
    });
    const descriptor = { kind: "search", generation: ledger.version, scope };
    const offset = cursorOffset(input.cursor, descriptor);
    const selected = candidates.slice(offset, offset + limit);
    const selectedEvidence = selected.flatMap(({ claim }) =>
      claim.evidence.slice(0, evidenceLimit),
    );
    await verifyEvidence(identity, selectedEvidence, sources);
    const page = selected.map(({ claim, score }) => {
      const assertion = truncate(claim.assertion, MAX_ASSERTION);
      return {
        claim_id: claim.id,
        note_id: notesByClaim.get(claim.id) ?? null,
        title: truncate(claim.title, MAX_TITLE).value,
        assertion: assertion.value,
        assertion_truncated: assertion.truncated,
        kind: claim.kind,
        status: claim.state,
        current: CURRENT_STATES.has(claim.state),
        conflicted: conflicted.has(claim.id),
        topic: truncate(claim.topic, MAX_LABEL).value,
        subtopic: truncate(claim.subtopic, MAX_LABEL).value,
        scope: truncate(claim.scope, MAX_LABEL).value,
        observed_at: claim.observedAt,
        recorded_at: claim.recordedAt,
        score,
        conflicts: (relations.get(claim.id) ?? [])
          .filter((relation) => relation.type === "conflicts")
          .slice(0, 4)
          .map((relation) => relationSummary(relation, claim.id, claimsById)),
        evidence: claim.evidence
          .slice(0, evidenceLimit)
          .map((entry) => evidenceCitation(entry, sources)),
      };
    });
    return {
      ...envelope,
      query,
      status,
      results: page,
      next_cursor: nextCursor(candidates, offset, limit, descriptor),
    };
  }

  async function readSource(identity, input, snapshot) {
    if (!sourceReader || typeof sourceReader.read !== "function") {
      throw new MemoryRetrievalUnavailableError(
        "Authenticated source reading is not configured",
      );
    }
    const revisionId = boundedText(input.target_id, 128, "target_id");
    if (!UUID.test(revisionId)) {
      throw new Error("source target_id must be an immutable revision UUID");
    }
    const source = await sourceReader.read({
      ownerId: identity.userId,
      projectId: identity.projectId,
      revisionId,
    });
    if (!source) throw new MemoryNotFoundError("Memory source was not found");
    if (
      source.ownerId !== identity.userId ||
      source.projectId !== identity.projectId ||
      source.revisionId !== revisionId ||
      typeof source.markdown !== "string"
    ) {
      throw new Error(
        "Memory source reader returned a different tenant record",
      );
    }
    const markdownHash = digest(source.markdown);
    if (source.contentHash && source.contentHash !== markdownHash) {
      throw new Error("Memory source content hash does not match its bytes");
    }
    const ledgerSource = snapshot.ledger.sources.find(
      (entry) => entry.revisionId === revisionId,
    );
    if (ledgerSource && ledgerSource.contentHash !== markdownHash) {
      throw new Error(
        "Processed memory source does not match immutable revision bytes",
      );
    }
    const maxChars = boundedInteger(
      input.max_chars,
      2_000,
      1,
      4_000,
      "max_chars",
    );
    const descriptor = {
      kind: "source",
      generation: snapshot.ledger.version,
      scope: scopeDigest({
        ownerId: identity.userId,
        projectId: identity.projectId,
        revisionId,
        markdownHash,
      }),
    };
    let offset =
      input.query && !input.cursor
        ? Math.max(
            0,
            source.markdown.toLowerCase().indexOf(input.query.toLowerCase()) -
              160,
          )
        : cursorOffset(input.cursor, descriptor);
    if (offset > source.markdown.length)
      throw new Error("cursor is out of range");
    if (/[\uDC00-\uDFFF]/u.test(source.markdown[offset])) offset++;
    const text = truncate(source.markdown.slice(offset), maxChars).value;
    if (!text && offset < source.markdown.length)
      throw new Error("Source window cannot fit a Unicode character");
    const next =
      offset + text.length < source.markdown.length
        ? encodeCursor({ ...descriptor, offset: offset + text.length })
        : null;
    return {
      ...catalogEnvelope(snapshot.ledger, snapshot.processing),
      target_type: "source",
      source: {
        revision_id: revisionId,
        node_id: source.nodeId,
        session_id: source.sessionId,
        revision: source.revision,
        title: truncate(source.title, MAX_TITLE).value,
        summary: truncate(source.summary, MAX_SUMMARY).value,
        captured_at: source.capturedAt,
        content_hash: markdownHash,
        capture_content_hash: source.captureContentHash ?? null,
        processed: Boolean(ledgerSource),
        start: offset,
        end: offset + text.length,
        text,
      },
      next_cursor: next,
    };
  }

  async function read(identity, input) {
    const targetType = input?.target_type;
    if (!["note", "claim", "source"].includes(targetType)) {
      throw new Error("target_type is invalid");
    }
    const snapshot = await load(identity);
    if (targetType === "source") return readSource(identity, input, snapshot);
    const envelope = catalogEnvelope(snapshot.ledger, snapshot.processing);
    if (envelope.catalog_status === "empty") {
      return {
        ...envelope,
        target_type: targetType,
        note: null,
        claim: null,
        evidence: [],
        next_cursor: null,
      };
    }
    const targetId = boundedText(input.target_id, 128, "target_id");
    const evidenceLimit = boundedInteger(
      input.evidence_limit,
      4,
      1,
      8,
      "evidence_limit",
    );
    const sources = new Map(
      snapshot.ledger.sources.map((source) => [source.revisionId, source]),
    );
    const { claims } = claimView(snapshot.ledger, snapshot.projection);
    const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
    const { relations, conflicted } = relationIndex(snapshot.ledger);
    if (targetType === "claim") {
      const claim = claimsById.get(targetId);
      if (!claim) throw new MemoryNotFoundError("Memory claim was not found");
      const assertion = truncate(claim.assertion, MAX_ASSERTION);
      const descriptor = readDescriptor(
        "claim",
        snapshot.ledger.version,
        targetId,
        identity,
      );
      const page = await evidencePage(
        claim.evidence,
        sources,
        input.cursor,
        evidenceLimit,
        descriptor,
        (entries) => verifyEvidence(identity, entries, sources),
      );
      return {
        ...envelope,
        target_type: "claim",
        claim: {
          claim_id: claim.id,
          canonical_claim_id: claim.canonicalId,
          title: truncate(claim.title, MAX_TITLE).value,
          assertion: assertion.value,
          assertion_truncated: assertion.truncated,
          subject: truncate(claim.subject, MAX_LABEL).value,
          aspect: truncate(claim.aspect, MAX_LABEL).value,
          scope: truncate(claim.scope, MAX_LABEL).value,
          kind: claim.kind,
          status: claim.state,
          current: CURRENT_STATES.has(claim.state),
          conflicted: conflicted.has(claim.id),
          topic: truncate(claim.topic, MAX_LABEL).value,
          subtopic: truncate(claim.subtopic, MAX_LABEL).value,
          observed_at: claim.observedAt,
          recorded_at: claim.recordedAt,
          source_revision_id: claim.sourceId,
          relations_truncated:
            (relations.get(claim.id)?.length ?? 0) > MAX_RELATIONS,
          relations: (relations.get(claim.id) ?? [])
            .slice(0, MAX_RELATIONS)
            .map((relation) => relationSummary(relation, claim.id, claimsById)),
        },
        note: null,
        ...page,
      };
    }
    const note = snapshot.projection.items.find((item) => item.id === targetId);
    if (!note) throw new MemoryNotFoundError("Memory note was not found");
    const version = latestVersion(note);
    const body = truncate(version.body, MAX_NOTE_BODY);
    const noteClaims = note.claimIds
      .map((id) => claimsById.get(id))
      .filter(Boolean);
    const descriptor = readDescriptor(
      "note",
      snapshot.ledger.version,
      targetId,
      identity,
    );
    const page = await evidencePage(
      version.evidence ?? noteClaims.flatMap((claim) => claim.evidence),
      sources,
      input.cursor,
      evidenceLimit,
      descriptor,
      (entries) => verifyEvidence(identity, entries, sources),
    );
    return {
      ...envelope,
      target_type: "note",
      note: {
        note_id: note.id,
        title: truncate(version.title, MAX_TITLE).value,
        body: body.value,
        body_truncated: body.truncated,
        kind: note.kind,
        status: version.status,
        conflicted: note.claimIds.some((id) => conflicted.has(id)),
        observed_at: version.observedAt,
        claim_ids: [...note.claimIds],
      },
      claim: null,
      ...page,
    };
  }

  // Internal recipient agent action; not a new receiver-wide search capability.
  async function searchSources(identity, { query }) {
    if (typeof sourceReader?.search !== "function")
      throw new MemoryRetrievalUnavailableError("Source search unavailable");
    const snapshot = await load(identity);
    const ids = await sourceReader.search({
      ownerId: identity.userId,
      projectId: identity.projectId,
      query,
    });
    if (!Array.isArray(ids) || ids.length > 4)
      throw new Error("Source search exceeded its limit");
    const results = [];
    for (const id of ids)
      results.push(
        (
          await readSource(
            identity,
            { target_id: id, query: query.trim(), max_chars: 1200 },
            snapshot,
          )
        ).source,
      );
    return {
      ...catalogEnvelope(snapshot.ledger, snapshot.processing),
      results,
    };
  }
  return { topics, search, read, searchSources };
}
