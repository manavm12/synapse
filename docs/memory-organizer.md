# Postgres memory organizer contract

Contract v1, shared with the retrieval task. The queue dependency
is commit `243fcc9` (locally cherry-picked as `406ce33`). This feature adds
migration `202609070004_memory_ledger.sql` and `src/server/memory-organizer/`.

## Integration API

`createMemoryLedgerAdapter({ pool })` from `storage.mjs` exposes:

- `load({ ownerId, projectId }) -> { ledger, projection }`: consistent, tenant
  scoped read; an unprocessed project returns the empty core ledger/projection.
- `loadSource(envelope) -> { source, ledger }`: validates the v1 envelope against
  immutable `memory_revisions` and its checked project/node/session relationships,
  then loads the ledger in the same read transaction.
- `commit({ client, source, result })`: called only inside the queue's fenced
  transaction. Validates durable source, generation, proposal replay and evidence,
  then appends normalized ledger rows and replaces the current projection. Never
  opens, commits, or rolls back a transaction on the supplied client.

`createMemoryOrganizerHandler({ adapter, api, reviewStrategy = "always",
maxStageCalls = 3, now = () => new Date(), signal })` from `handler.mjs` returns `{ process, commit }` for
`createMemoryProcessingRunner`. `process(source)` performs bounded inference
outside the write transaction. It also accepts `process(source, { signal })` for
per-job cancellation, combined with the optional constructor shutdown signal.

Models and credentials are explicitly supplied to `createMemoryInferenceAPI`
from `api.mjs`; construction makes no request. Exact options:

```js
const api = createMemoryInferenceAPI({
  apiKey, model, reviewer: model, fetcher: fetch,
  timeoutMs: 120_000, maxOutputTokens: 18_000,
  maxPromptCharacters: 200_000, maxResponseBytes: 2_000_000,
  reasoningEffort: "medium", // null omits reasoning for models without it
});
```

The injected API contract is `structured(stage, prompt, schema, { signal }) ->
{ value, model, usage: { input_tokens, output_tokens } }`. Stages are `extract`,
`reconcile`, and `review`. The production adapter calls the
[Responses API with strict structured output](https://developers.openai.com/api/docs/guides/structured-outputs),
`store: false`, explicit standard service (`service_tier: "default"`), disabled
truncation, no tools, a response byte limit and a deadline
covering fetch and body reads. Provider error bodies and credentials are never
copied into errors or audit records. Cancellation aborts active requests.

`process` returns `{ changeSet, audit }`. The change set carries its replay
proposal; commit re-runs it against the current durable source and locked ledger.
The successful source audit records prompt version, SHA-256 prompt hashes,
configured models, per-stage request counts, usage and review strategy/outcome.
It stores no raw prompts or model responses. Failed attempts remain pending/failed
in the queue with bounded error text; this version does not persist detailed
failed-call usage. Use provider usage reporting for actual billing reconciliation.

The provider wire format groups claims under exact current source segment keys.
Every current segment is a required object property, containing either a nonempty
claims array or a non-claim disposition and reason (never both). A claim's group is its
model-selected primary evidence; `additionalEvidence` may cite other current
segments or earlier accepted context. Shared schema definitions keep evidence
enums single-copy. The adapter validates the grouped response, flattens it in
source order, deduplicates citations, and derives complete coverage from those
citations. The handler and core still receive the original flat contract.

An uncited empty group must contain a model-authored non-claim disposition and
reason. Cited groups get `claims` coverage deterministically. This does not prove
semantic coverage: independent review still checks every source segment for
omitted assertions and checks that each assertion is entailed by its selected
evidence. Grouping never authorizes unsupported claims or changes earlier
committed IDs. Audits identify the format as `source-groups-v1` (`flat-v1` for
injected adapters that do not implement the grouped wire format).

Provider patterns require nonblank claim metadata/assertions and exclusion reasons,
matching the core's nonempty-text checks. Core validation independently enforces current-source support, unique evidence,
complete coverage, and total claim bounds. Inputs fail closed on provider enum
limits rather than truncating evidence. Flat proposal repairs identify all
evidence and coverage inconsistencies together within the existing call budget.
That detail is model input only, not audit/log output. Exhausted repairs expose
only fixed `validation_reason` and `inference_stage` operational codes.

Local incoming claim refs are assigned deterministically (`c1`, `c2`, ...) from
the validated extraction array before reconciliation and review. The transport
shape retains its `ref` string for compatibility, but the model's labels are not
authoritative. This cannot change evidence, claim content, coverage, or previously
committed IDs. Audit records identify this policy as
`claimRefStrategy: "source-order-v1"`. Reconciliation is rebuilt after extraction
repairs; no action can bind to a stale model-generated label.

## Storage/read contract

All tables are in `synapse_private`, keyed/scoped by `owner_id, project_id`:

- `memory_ledger_projects`: current `generation` and core/projection versions.
- `memory_ledger_sources`: immutable processed `revision_id`, `generation`,
  exact Markdown `content_hash`, `recorded_at` and bounded inference audit metadata.
- `memory_claims`: immutable `id` (core string ID), `source_revision_id`,
  `ordinal`, `ref`, `subject`, `aspect`, `scope`, `title`, `assertion`, `kind`,
  `status`, `topic`, `subtopic`, `observed_at`, `recorded_at`.
- `memory_evidence`: immutable `segment_id`, `revision_id`, `start_offset`,
  `end_offset`, `quote`. Offsets are UTF-16 JavaScript string indices, end-exclusive.
- `memory_claim_evidence`: immutable ordered `claim_id, ordinal, segment_id` links.
- `memory_claim_relations`: immutable `id`, `source_revision_id`, `ordinal`,
  `from_claim_id`, `to_claim_id`, `type`, `reason`, `introduced_in`.
- `memory_segment_coverage`: immutable `revision_id, ordinal, segment_id,
  disposition, reason`.
- `memory_projection_topics`: current `id, ordinal, parent_id, title, summary,
  index_text, generation`.
- `memory_projection_notes`: current `id, ordinal, key, kind, primary_topic_id,
  title, body, status, observed_at, generation`.
- `memory_projection_note_claims`: current ordered `note_id, ordinal, claim_id`.
- `memory_projection_note_evidence`: current ordered `note_id, ordinal, segment_id`.
- `memory_projection_edges`: current `id, ordinal, from_note_id, to_note_id,
  type, reason, relation_id, generation`.

`load` reconstructs the ordered ledger from normalized rows and regenerates the
projection. Direct retrieval queries can read the persisted projection tables;
those rows are replaced in the same transaction as the ledger generation.
The projection follows the core shape (`topics`, `items`, `edges`). A note has one
current `versions` entry. Historical claims stay in immutable tables and are
explicitly labelled in note bodies. The projection is replaceable, never the
authority for accepted claims. All reads must scope BOTH owner and project.

`synapse_runtime` has SELECT only on ledger/projection tables with owner RLS via
`app.current_user_id`; it cannot write derived memory. The worker additionally
sets `app.current_project_id`, and worker RLS requires both settings. The queue
still owns its separate scheduling permissions. Supabase `anon`/`authenticated`
receive no direct derived table access. For multi-query retrieval, use one
read-only repeatable-read transaction to avoid crossing projection generations.

## Quality and cost

The reused prototype stages are extraction, reconciliation (only with existing
live targets), and independent semantic review. Review defaults to `always`;
explicit `never` is available for experiments and is recorded in audit metadata.
Selective review / one-call organization has not been validated and is not the
default. Each stage has at most three requests per queue attempt, with bounded
prompt/output sizes and request deadlines. Queue retry limits multiply this cost
ceiling; they do not establish a dollar budget. No inference is run by migration,
tests, module import, or handler construction.

Structural tests cannot establish semantic recall. The prototype's 28/34
retrieval result did not meet its old quality target. Production startup/config,
evaluation budget and deployment remain owned by the parent integration task.

The initial adapter reads full project history and validates earlier evidence
against durable Markdown; it fails on source/context limits rather than truncating.
This favors preservation for the initial workload but needs a later bounded
catalog/candidate strategy for large histories. SQL foreign keys enforce tenant
and revision references; exact UTF-16 offset/text validation happens in the adapter.

## Verification

`test/server/memory-organizer.test.mjs` uses synthetic proposals and mocked fetch
responses only. `test/server/memory-organizer-postgres.test.mjs` requires an admin
`TEST_DATABASE_URL` capable of creating databases. It creates and drops one
uniquely named disposable database, leaving the supplied database's fixtures
untouched. It tests real worker/runtime roles, tenant RLS, provenance, stale
generations/fences, rollback, idempotence, recaps, conflicts and empty proposals.
The suite applies only this worktree's migrations. No live inference is used.

Run full coverage with a disposable PostgreSQL service and `TEST_DATABASE_URL`
set; otherwise the database suites skip and their uncovered code causes the
repository coverage gate to fail. With a fresh disposable test database:

```sh
DATABASE_SSL=disable npm run check
```

Supply `TEST_DATABASE_URL` securely in the environment. The existing
`schema.test.mjs` uses the supplied database directly, so a fresh database is
required for that combined run. Multiple fresh SQL suites also create shared
Postgres roles; serial SQL provisioning avoids cluster-wide role creation races.
