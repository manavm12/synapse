# Authenticated memory retrieval

The retrieval service exposes the organizer's immutable claim ledger and
deterministic topic projection without an embedding, reranking, or paid inference
dependency. It accepts an injected ledger adapter with this stable contract:

```js
adapter.load({ ownerId, projectId }) -> { ledger, projection, processing? }
```

`ownerId` and `projectId` come from the verified MCP identity. They are never tool
arguments. The service validates both dimensions on every returned snapshot,
checks the projection generation against the ledger, and fails closed for unknown
claims, topics, sources, or evidence revisions.

The optional `processing` summary may contain bounded integer `queued` and `failed`
counts. It only improves the empty-state explanation. When it is absent, an empty
ledger says that accepted revisions may be absent or unprocessed; it does not claim
that a queue is empty or invent results.

## MCP tools

All three tools are read-only and use the existing OAuth security schemes.

- `memory_topics` returns one page of immediate child topics and direct note labels.
  It never returns note bodies, evidence, or a whole catalog.
- `search_memory` runs deterministic lexical ranking over claim title, assertion,
  subject, aspect, scope, topic, subtopic, kind, and status. It is deliberately not
  described as semantic search. A nonempty query is mandatory, results are capped
  at 10, and each result contains at most three evidence snippets.
- `read_memory` reads one note or claim with at most eight evidence snippets. Its
  explicit `target_type: "source"` mode is the only path that returns raw session
  Markdown. A source target must be an exact revision UUID, and each response is a
  contiguous slice of at most 4,000 JavaScript characters.

Opaque pagination cursors are bound to the authenticated owner, project, ledger
generation, operation, and query/filter/topic/target. Reusing a cursor after a new
projection generation, for another query, or for another tenant fails rather than
mixing views.

## Status and provenance

Search operates on immutable claims, including claims that no longer appear as
current projection notes. Results report the reducer-derived status (`active`,
`disputed`, `resolved`, `superseded`, `equivalent`, or `historical`) and an explicit
`current` flag. The `conflicted` filter includes both ends of an explicit conflict,
and claim reads return bounded relation metadata. No relationship is inferred from
similar text.

Before returning a quote, retrieval loads its authoritative tenant-scoped revision,
checks the stored Markdown hash against the ledger source, and verifies that the
recorded UTF-16 offsets slice to the exact evidence quote. Returned citations name
the immutable revision and segment, source revision number, offsets, capture time,
and content hash. Long segments are returned as an exact prefix with both snippet
and full-segment offsets marked; callers can explicitly read the source revision
when more context is needed.

`createMemorySourceReader({ pool })` supplies the Postgres source boundary. It uses
a read-only repeatable-read transaction, sets both trusted tenant settings, and
also filters the immutable revision by owner and project. This defense is in
addition to database RLS. An exact source UUID may refer to a captured revision that
has not reached the organizer yet; the response labels it `processed: false` and
does not manufacture claims for it.

Memory titles, assertions, bodies, quotes, and source Markdown are untrusted data.
They are serialized as tool results, never executed or interpolated into SQL, and
tool descriptions instruct the caller not to treat them as instructions.

## Integration

Construct the service after the durable organizer adapter and database pool exist:

```js
import {
  createMemoryRetrievalService,
  createMemorySourceReader,
} from "../src/server/memory-retrieval/index.mjs";

const memoryRetrieval = createMemoryRetrievalService({
  adapter: createMemoryLedgerAdapter({ pool }),
  sourceReader: createMemorySourceReader({ pool }),
});
```

Pass `memoryRetrieval` into `createApplication`. The application deliberately keeps
this dependency injectable so startup composition and the final shared MCP registry
can be resolved when the organizer storage and messaging branches are integrated.

## Automatic context for incoming messages

A separate retrieval model navigates the recipient's existing memory before a
cloud message is submitted to a native task. Each response chooses searches,
topic browsing, claim/note/source reads, or source-text searches; later decisions
see those results. The model selects returned evidence IDs. The service verifies
citations and code preserves conflict, successor and canonical-claim groups.
The original peer message remains intact and the context is explicitly untrusted.

The receiver calls `POST /receiver/messages/:message_id/context` after durable
import. The only input is the stored message ID. The database derives recipient
and project from the authenticated installation and stored message, schedules one
durable attempt, and returns `pending` until it finishes. Neither sender nor
receiver credentials acquire general memory-search permissions. Earlier messages
come only from the same conversation (latest four, at most 8 KiB to the model).

Enable with migration `202609130001_message_memory.sql`,
`MESSAGE_MEMORY_ENABLED=true` on the HTTP service, and a separate process running
`npm run worker:message-memory`. That worker uses `DATABASE_WORKER_URL`, existing
verified-TLS configuration, `OPENAI_API_KEY`, and `MESSAGE_MEMORY_MODEL` (default
`gpt-5-mini`, low reasoning). The HTTP service does not need an inference key.
Both service and worker are disabled by default. Deploy the migration/backend
before refreshing receivers; older servers preserve ordinary delivery.

Limits are six model requests, twelve retrieval actions, thirty seconds from the
context request, and 8 KiB injected context within the native 64 KiB limit.
Timeouts, outages, stale generations, and crashed attempts deliver the original
message with an explicit unavailable indication. Completed searches can report
`no_match`; verified incomplete context reports `partial`. Paid attempts are not
silently retried after a crash. Scale workers to handle concurrent arrivals;
queued preparation that exceeds the deadline falls back to normal delivery.

Before native submission, the receiver verifies the message, recipient,
installation and content bindings and renews normal delivery authorization. The
exact rendered prompt is stored atomically with the native-attempt record
(SQLite schema 5). Duplicate deliveries and uncertain native outcomes retain the
same prompt and existing fencing. Both initial child creation and existing-task
queuing use this path. Context is timestamped; a long native queue delay can make
it old by execution time.

The model uses the shared Responses adapter with strict JSON actions; see the
[OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)
for the model/tool execution boundary. This is a bounded navigation loop, not an
embedding requirement. Current ledger loading and literal source search are
suitable for modest graphs; larger deployments need measured indexing work.
Tests use compact existing fixtures and mock inference/native submission with
real PostgreSQL authorization. They do not establish model recall on real memory
or replace a live two-account desktop rollout check. No private graph, embedding
cache, expanded benchmark or API credential is committed.

Rollback: disable `MESSAGE_MEMORY_ENABLED` on HTTP and stop the context worker;
ordinary message delivery continues. Keep the additive migration and native prompt
records so uncertain submissions retain their identity. Do not downgrade the local
receiver to a build that cannot read SQLite schema 5.
