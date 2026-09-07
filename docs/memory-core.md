# Deterministic memory core

`src/memory/core` is a pure library boundary between a future inference handler and
a tenant-scoped persistence adapter. It makes no model calls, performs no retrieval,
and owns no queue or database schema.

## Boundary

The worker supplies the v1 revision envelope documented in
`docs/integration-workstreams.md`, the authenticated `ownerId` and `projectId` from
its trusted adapter context, and already-produced extraction and reconciliation
proposals. The normal flow is:

```js
import {
  applyMemoryChangeSet,
  emptyLedger,
  prepareMemoryChangeSet,
} from "../src/memory/core/index.mjs";

const ledger = emptyLedger({ ownerId, projectId });
const changeSet = prepareMemoryChangeSet({
  ledger,
  envelope,
  expectedIdentity: { ownerId, projectId },
  extraction,
  reconciliation,
  recordedAt,
});
const nextLedger = applyMemoryChangeSet(ledger, changeSet);
```

`prepareMemoryChangeSet`:

- validates all required v1 envelope fields and checks its explicit owner/project
  UUIDs against trusted adapter identity;
- preserves the exact accepted Markdown string, hashes it, and derives segments
  whose offsets slice back to the exact source text;
- validates bounded proposal shapes, complete segment coverage, current-source
  evidence, scopes, live targets, relation direction, and replacement chronology;
- returns one deterministic append change set with an expected ledger version and
  a regenerable topic projection.

`applyMemoryChangeSet` is the replay seam. It requires the exact next ledger version,
checks tenant/project and revision consistency, appends without editing prior
entries, validates the resulting graph, and independently regenerates the supplied
projection. A persistence adapter should translate the four append collections and
the projection to normalized Postgres mutations, then commit them together with
job completion under Task B's validated lease fence. It must enforce the expected
ledger version in that transaction. This library neither opens a transaction nor
claims a job.

The ledger records processed revision identity and content hashes, but does not
store the complete Markdown. The change set carries the normalized envelope,
including exact Markdown, so the future adapter can verify it against the durable
`memory_revisions` row. The durable revision remains authoritative.

## Preserved invariants

- Claims, evidence, source records, coverage, and relations are append-only.
- Every new claim cites at least one segment from the current revision. Earlier
  accepted evidence can supplement, but never replace, current-source support.
- Evidence retains its original revision ID, quote, and JavaScript string offsets.
- `subject`, `aspect`, and `scope` remain separate. Explicitly different scopes
  cannot retire each other; only an explicit replacement may clarify an earlier
  `unqualified` scope.
- Equivalence, supersession, resolution, and conflict history remains inspectable.
- An older observation cannot replace a newer claim, and a newer source cannot be
  labeled as already replaced by an older claim.
- Topic projection is deterministic and regenerable. Labels are navigation, not
  claim identity. Subtopics require two live claims; bundles stay within eight
  claims and a 3,000-character packing budget without truncating a claim.

## Deliberate limitations

These checks establish structural integrity, provenance, replayability, and narrow
chronology rules. They do not establish that a model extracted every meaning,
interpreted a source correctly, selected the right semantic relationship, or
produced useful retrieval labels. Complete coverage means every segment received a
disposition, not that every durable fact was found. Synthetic tests are engineering
evidence only. The prototype's reported 28/34 retrieval result did not meet its old
quality target and is not a pass.

This milestone intentionally excludes inference, semantic review, retrieval,
embeddings, SQLite, production Postgres tables, queue scheduling, capture changes,
and MCP changes.
