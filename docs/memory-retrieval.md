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
