import { isDeepStrictEqual } from "node:util";
import {
  applyMemoryChangeSet,
  CORE_VERSION,
  deriveTopicProjection,
  emptyLedger,
  normalizeSourceEnvelope,
  PROJECTION_VERSION,
  prepareMemoryChangeSet,
  segmentsFor,
  validateLedger,
} from "../../memory/core/index.mjs";
import { validateIdentity } from "../../memory/core/source.mjs";

const scoped = "owner_id = $1 and project_id = $2";
const identityValues = ({ ownerId, projectId }) => [ownerId, projectId];
const iso = (value) => new Date(value).toISOString();
const envelopeKeys = [
  "version",
  "ownerId",
  "projectId",
  "revisionId",
  "nodeId",
  "sessionId",
  "revision",
  "captureId",
  "title",
  "summary",
  "markdown",
  "capturedAt",
];
const wireEnvelope = (source) =>
  Object.fromEntries(envelopeKeys.map((key) => [key, source[key]]));

export class MemoryLedgerGenerationError extends Error {
  constructor() {
    super(
      "Memory ledger generation changed; organize again against the current ledger",
    );
    this.name = "MemoryLedgerGenerationError";
  }
}

async function setScope(client, identity) {
  validateIdentity(identity);
  await client.query(
    "select set_config('app.current_user_id', $1, true), set_config('app.current_project_id', $2, true)",
    identityValues(identity),
  );
  const project = await client.query(
    "select id from public.projects where owner_id = $1 and id = $2",
    identityValues(identity),
  );
  if (project.rowCount !== 1)
    throw new Error("Memory project is not available to this owner");
}

const sourceSelect = `select r.*, a.client_session_id
  from public.memory_revisions r
  join public.memory_nodes n on n.id = r.node_id and n.owner_id = r.owner_id
    and n.project_id = r.project_id and n.kind = 'session'
  join public.agent_sessions a on a.id = r.author_session_id
    and a.owner_id = r.owner_id and a.project_id = r.project_id
    and a.client_session_id = n.source_session_id
  join public.projects p on p.id = r.project_id and p.owner_id = r.owner_id`;

function sourceFromRow(row) {
  return normalizeSourceEnvelope(
    {
      version: 1,
      ownerId: row.owner_id,
      projectId: row.project_id,
      revisionId: row.id,
      nodeId: row.node_id,
      sessionId: row.client_session_id,
      revision: row.revision,
      captureId: row.capture_id,
      title: row.title,
      summary: row.summary,
      markdown: row.markdown,
      capturedAt: iso(row.created_at),
    },
    { ownerId: row.owner_id, projectId: row.project_id },
  );
}

async function durableSource(client, envelope) {
  normalizeSourceEnvelope(envelope, envelope);
  const rows = await client.query(
    `${sourceSelect} where r.owner_id = $1 and r.project_id = $2 and r.id = $3`,
    [...identityValues(envelope), envelope.revisionId],
  );
  if (rows.rowCount !== 1)
    throw new Error(
      "Source revision relationships are unavailable or inconsistent",
    );
  const source = sourceFromRow(rows.rows[0]);
  if (!isDeepStrictEqual(wireEnvelope(source), wireEnvelope(envelope)))
    throw new Error("Source envelope does not match the durable revision");
  return source;
}

const evidenceFromRow = (row) => ({
  segmentId: row.segment_id,
  documentId: row.revision_id,
  start: row.start_offset,
  end: row.end_offset,
  quote: row.quote,
});

async function readLedger(client, identity) {
  const values = identityValues(identity);
  const metadata = (
    await client.query(
      `select * from synapse_private.memory_ledger_projects where ${scoped}`,
      values,
    )
  ).rows[0];
  const ledger = emptyLedger(identity);
  if (!metadata) return ledger;
  if (
    metadata.core_version !== CORE_VERSION ||
    metadata.projection_version !== PROJECTION_VERSION
  )
    throw new Error("Unsupported stored memory core or projection version");
  ledger.version = Number(metadata.generation);
  const sourceRows = (
    await client.query(
      `${sourceSelect} join synapse_private.memory_ledger_sources s
      on s.owner_id = r.owner_id and s.project_id = r.project_id and s.revision_id = r.id
      where s.owner_id = $1 and s.project_id = $2 order by s.generation`,
      values,
    )
  ).rows;
  const accepted = (
    await client.query(
      `select * from synapse_private.memory_ledger_sources where ${scoped} order by generation`,
      values,
    )
  ).rows;
  if (
    accepted.length !== ledger.version ||
    sourceRows.length !== accepted.length
  )
    throw new Error("Ledger source conservation failed");
  const knownSegments = new Map();
  const sourcesById = new Map();
  for (const [index, row] of sourceRows.entries()) {
    const source = sourceFromRow(row);
    const stored = accepted[index];
    if (
      stored.revision_id !== source.revisionId ||
      Number(stored.generation) !== index + 1 ||
      stored.content_hash !== source.contentHash
    )
      throw new Error(
        "Stored source hash or generation does not match durable revision",
      );
    sourcesById.set(source.revisionId, source);
    for (const segment of segmentsFor(source))
      knownSegments.set(segment.id, segment);
    ledger.sources.push({
      revisionId: source.revisionId,
      nodeId: source.nodeId,
      sessionId: source.sessionId,
      revision: source.revision,
      captureId: source.captureId,
      capturedAt: source.capturedAt,
      contentHash: source.contentHash,
    });
  }
  const evidence = new Map();
  for (const row of (
    await client.query(
      `select * from synapse_private.memory_evidence where ${scoped}`,
      values,
    )
  ).rows) {
    const entry = evidenceFromRow(row);
    const segment = knownSegments.get(entry.segmentId);
    if (
      !segment ||
      !isDeepStrictEqual(entry, {
        segmentId: segment.id,
        documentId: segment.documentId,
        start: segment.start,
        end: segment.end,
        quote: segment.text,
      })
    )
      throw new Error(
        "Stored evidence does not match durable source offsets and text",
      );
    evidence.set(entry.segmentId, entry);
  }
  if (evidence.size !== knownSegments.size)
    throw new Error("Stored source segments are incomplete");
  const links = (
    await client.query(
      `select * from synapse_private.memory_claim_evidence where ${scoped} order by ordinal`,
      values,
    )
  ).rows;
  const claims = (
    await client.query(
      `select c.* from synapse_private.memory_claims c
    join synapse_private.memory_ledger_sources s on s.owner_id = c.owner_id
      and s.project_id = c.project_id and s.revision_id = c.source_revision_id
    where c.owner_id = $1 and c.project_id = $2 order by s.generation, c.ordinal`,
      values,
    )
  ).rows;
  ledger.claims = claims.map((row) => ({
    ref: row.ref,
    subject: row.subject,
    aspect: row.aspect,
    scope: row.scope,
    title: row.title,
    assertion: row.assertion,
    kind: row.kind,
    status: row.status,
    topic: row.topic,
    subtopic: row.subtopic,
    evidence: links
      .filter((link) => link.claim_id === row.id)
      .map((link) => evidence.get(link.segment_id)),
    id: row.id,
    sourceId: row.source_revision_id,
    observedAt: iso(row.observed_at),
    recordedAt: iso(row.recorded_at),
  }));
  for (const claim of ledger.claims) {
    if (
      claim.observedAt !== sourcesById.get(claim.sourceId)?.capturedAt ||
      !claim.evidence.some((entry) => entry?.documentId === claim.sourceId)
    )
      throw new Error("Stored claim lacks current-source provenance");
  }
  ledger.relations = (
    await client.query(
      `select r.* from synapse_private.memory_claim_relations r
    join synapse_private.memory_ledger_sources s on s.owner_id = r.owner_id
      and s.project_id = r.project_id and s.revision_id = r.source_revision_id
    where r.owner_id = $1 and r.project_id = $2 order by s.generation, r.ordinal`,
      values,
    )
  ).rows.map((row) => ({
    id: row.id,
    from: row.from_claim_id,
    to: row.to_claim_id,
    type: row.type,
    reason: row.reason,
    sourceId: row.source_revision_id,
    introducedIn: Number(row.introduced_in),
  }));
  ledger.coverage = (
    await client.query(
      `select c.* from synapse_private.memory_segment_coverage c
    join synapse_private.memory_ledger_sources s on s.owner_id = c.owner_id
      and s.project_id = c.project_id and s.revision_id = c.revision_id
    where c.owner_id = $1 and c.project_id = $2 order by s.generation, c.ordinal`,
      values,
    )
  ).rows.map((row) => ({
    segmentId: row.segment_id,
    disposition: row.disposition,
    reason: row.reason,
    sourceId: row.revision_id,
  }));
  const covered = new Set();
  for (const entry of ledger.coverage) {
    const segment = knownSegments.get(entry.segmentId);
    const cited = ledger.claims.some(
      (claim) =>
        claim.sourceId === entry.sourceId &&
        claim.evidence.some((item) => item.segmentId === entry.segmentId),
    );
    if (
      !segment ||
      segment.documentId !== entry.sourceId ||
      covered.has(entry.segmentId) ||
      (entry.disposition === "claims") !== cited
    )
      throw new Error("Stored coverage disagrees with source evidence");
    covered.add(entry.segmentId);
  }
  if (covered.size !== knownSegments.size)
    throw new Error("Stored source coverage is incomplete");
  validateLedger(ledger);
  return ledger;
}

// Table/column identifiers below come only from this module, never a proposal.
async function insertRows(client, identity, table, columns, rows) {
  for (let offset = 0; offset < rows.length; offset += 250) {
    const values = [];
    const tuples = rows.slice(offset, offset + 250).map((row) => {
      const fields = [...identityValues(identity), ...row];
      return `(${fields
        .map((value) => {
          values.push(value);
          return `$${values.length}`;
        })
        .join(",")})`;
    });
    await client.query(
      `insert into synapse_private.${table} (owner_id, project_id, ${columns.join(",")}) values ${tuples.join(",")}`,
      values,
    );
  }
}

async function writeProjection(client, identity, projection) {
  for (const table of [
    "memory_projection_edges",
    "memory_projection_note_evidence",
    "memory_projection_note_claims",
    "memory_projection_notes",
    "memory_projection_topics",
  ])
    await client.query(
      `delete from synapse_private.${table} where ${scoped}`,
      identityValues(identity),
    );
  const insert = (table, columns, rows) =>
    insertRows(client, identity, table, columns, rows);
  const generation = projection.ledgerVersion;
  await insert(
    "memory_projection_topics",
    [
      "id",
      "ordinal",
      "parent_id",
      "title",
      "summary",
      "index_text",
      "generation",
    ],
    projection.topics.map((topic, ordinal) => [
      topic.id,
      ordinal,
      topic.parentId || null,
      topic.title,
      topic.summary,
      topic.index,
      generation,
    ]),
  );
  await insert(
    "memory_projection_notes",
    [
      "id",
      "ordinal",
      "key",
      "kind",
      "primary_topic_id",
      "title",
      "body",
      "status",
      "observed_at",
      "generation",
    ],
    projection.items.map((item, ordinal) => {
      const version = item.versions[0];
      return [
        item.id,
        ordinal,
        item.key,
        item.kind,
        item.primary,
        version.title,
        version.body,
        version.status,
        version.observedAt,
        generation,
      ];
    }),
  );
  await insert(
    "memory_projection_note_claims",
    ["note_id", "ordinal", "claim_id"],
    projection.items.flatMap((item) =>
      item.claimIds.map((id, ordinal) => [item.id, ordinal, id]),
    ),
  );
  await insert(
    "memory_projection_note_evidence",
    ["note_id", "ordinal", "segment_id"],
    projection.items.flatMap((item) =>
      item.versions[0].evidence.map((entry, ordinal) => [
        item.id,
        ordinal,
        entry.segmentId,
      ]),
    ),
  );
  await insert(
    "memory_projection_edges",
    [
      "id",
      "ordinal",
      "from_note_id",
      "to_note_id",
      "type",
      "reason",
      "relation_id",
      "generation",
    ],
    projection.edges.map((edge, ordinal) => [
      edge.id,
      ordinal,
      edge.from,
      edge.to,
      edge.type,
      edge.reason,
      edge.relationId,
      generation,
    ]),
  );
}

export function createMemoryLedgerAdapter({ pool }) {
  if (typeof pool?.connect !== "function")
    throw new TypeError("A Postgres pool is required");
  async function read(identity, operation) {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      await setScope(client, identity);
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    async load(identity) {
      return read(identity, async (client) => {
        const ledger = await readLedger(client, identity);
        return { ledger, projection: deriveTopicProjection(ledger) };
      });
    },
    async loadSource(envelope) {
      return read(envelope, async (client) => ({
        source: await durableSource(client, envelope),
        ledger: await readLedger(client, envelope),
      }));
    },
    async commit({ client, source: envelope, result }) {
      // The caller owns the fenced transaction. Never commit independently here.
      await setScope(client, envelope);
      const source = await durableSource(client, envelope);
      await client.query(
        `insert into synapse_private.memory_ledger_projects
        (owner_id,project_id,generation,core_version,projection_version) values ($1,$2,0,$3,$4)
        on conflict (owner_id,project_id) do nothing`,
        [...identityValues(source), CORE_VERSION, PROJECTION_VERSION],
      );
      const metadata = (
        await client.query(
          `select generation from synapse_private.memory_ledger_projects
        where ${scoped} for update`,
          identityValues(source),
        )
      ).rows[0];
      if (
        Number(metadata.generation) !== result.changeSet.expectedLedgerVersion
      )
        throw new MemoryLedgerGenerationError();
      const ledger = await readLedger(client, source);
      if (
        !isDeepStrictEqual(
          wireEnvelope(result.changeSet.source),
          wireEnvelope(source),
        )
      )
        throw new Error("Change set source differs from durable revision");
      const expected = prepareMemoryChangeSet({
        ledger,
        envelope: source,
        expectedIdentity: source,
        extraction: result.changeSet.proposal.extraction,
        reconciliation: result.changeSet.proposal.reconciliation,
        recordedAt: result.changeSet.proposal.recordedAt,
      });
      if (!isDeepStrictEqual(expected, result.changeSet))
        throw new Error("Change set failed deterministic proposal replay");
      applyMemoryChangeSet(ledger, expected);
      const insert = (table, columns, rows) =>
        insertRows(client, source, table, columns, rows);
      await insert(
        "memory_ledger_sources",
        ["revision_id", "generation", "content_hash", "recorded_at", "audit"],
        [
          [
            source.revisionId,
            expected.nextLedgerVersion,
            source.contentHash,
            expected.proposal.recordedAt,
            JSON.stringify(result.audit),
          ],
        ],
      );
      await insert(
        "memory_evidence",
        ["segment_id", "revision_id", "start_offset", "end_offset", "quote"],
        segmentsFor(source).map((segment) => [
          segment.id,
          source.revisionId,
          segment.start,
          segment.end,
          segment.text,
        ]),
      );
      await insert(
        "memory_claims",
        [
          "id",
          "source_revision_id",
          "ordinal",
          "ref",
          "subject",
          "aspect",
          "scope",
          "title",
          "assertion",
          "kind",
          "status",
          "topic",
          "subtopic",
          "observed_at",
          "recorded_at",
        ],
        expected.append.claims.map((claim, ordinal) => [
          claim.id,
          claim.sourceId,
          ordinal,
          claim.ref,
          claim.subject,
          claim.aspect,
          claim.scope,
          claim.title,
          claim.assertion,
          claim.kind,
          claim.status,
          claim.topic,
          claim.subtopic,
          claim.observedAt,
          claim.recordedAt,
        ]),
      );
      await insert(
        "memory_claim_evidence",
        ["claim_id", "ordinal", "segment_id"],
        expected.append.claims.flatMap((claim) =>
          claim.evidence.map((entry, ordinal) => [
            claim.id,
            ordinal,
            entry.segmentId,
          ]),
        ),
      );
      await insert(
        "memory_claim_relations",
        [
          "id",
          "source_revision_id",
          "ordinal",
          "from_claim_id",
          "to_claim_id",
          "type",
          "reason",
          "introduced_in",
        ],
        expected.append.relations.map((relation, ordinal) => [
          relation.id,
          relation.sourceId,
          ordinal,
          relation.from,
          relation.to,
          relation.type,
          relation.reason,
          relation.introducedIn,
        ]),
      );
      await insert(
        "memory_segment_coverage",
        ["revision_id", "ordinal", "segment_id", "disposition", "reason"],
        expected.append.coverage.map((entry, ordinal) => [
          entry.sourceId,
          ordinal,
          entry.segmentId,
          entry.disposition,
          entry.reason,
        ]),
      );
      await writeProjection(client, source, expected.projection);
      await client.query(
        `update synapse_private.memory_ledger_projects
        set generation = $3 where ${scoped}`,
        [...identityValues(source), expected.nextLedgerVersion],
      );
      return {
        generation: expected.nextLedgerVersion,
        revisionId: source.revisionId,
      };
    },
  };
}
