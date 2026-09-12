# Synthetic recipient graph inspection

HarborDesk is a fictional project built through the current deterministic memory
core. Authored extraction and reconciliation proposals create the graph; no model
was paid to organize these sources. The production ledger is authoritative, while
the topic projection and vector index can be rebuilt.

| Component | Retained fixture |
| --- | ---: |
| Accepted source revisions / sessions | 31 |
| Claims | 204 |
| Root topics | 8 |
| Subject subtopics | 20 |
| Projection notes | 60 |
| Explicit relations | 64 |
| Source-only operational details | 20 |
| Development / held-out messages | 40 / 40 |

There are twenty `supersedes`, twenty `resolves`, twenty `equivalent`, and four
`conflicts` edges. The corpus includes production/staging values, historical
policies, accepted resolutions, repeated constraints, runbook references, owners,
monitoring facts and source-only operational details. Captures run from July 1 to
July 31, 2026; the final graph generation is 31.

The topics are Operations, Messaging, Identity, Storage, Performance, Billing,
Privacy and Release. Source quotes retain their exact original case and offsets.
Offsets follow the production core's JavaScript string indexing; hashes cover the
UTF-8 source markdown.

For example, diagnostic-event retention has an old seven-day production policy,
an approved thirty-day replacement, a two-day staging policy, a legal-hold
constraint, an accepted audit-record resolution, and an unresolved operational
report claiming seven days is still in use. The unresolved report has an explicit
conflict edge to the approved policy. Sharing a topic alone does not create that
relationship. Its cleanup-job time exists only in a source segment.

A second recipient graph contains tempting contrary values, including 999-day
policies. It is never searched for the primary recipient. A third, deliberately
impossible same-owner/different-project snapshot tests additional project fencing
in the file adapter. The production one-project-per-owner constraint means only
the first two graphs are round-tripped through SQL.

`fixtures/sources.json` preserves exact primary source envelopes;
`fixtures/proposals.json` preserves authored extraction/reconciliation proposals.
The benchmark's messages and expected evidence are separate JSON files. Gold
contains acceptable IDs, expected types/statuses/scopes and prohibited evidence;
none of those expectations enters a model request. Tests assert exact fixture
reconstruction. `FIXTURE_HASHES.json` records file, graph and rubric hashes.

The disposable PostgreSQL audit applies existing migrations, writes through the
real queue fences and organizer storage adapter, reconstructs the graph, and
checks runtime-role and source-reader tenant isolation. Generated database test
instances are dropped. The retained file graph is
`state/message-retrieval/graph.json`, with the full readable projection in
`state/message-retrieval/graph.md`.

All main-fixture sources are processed; twenty details intentionally have no
organized claim. A separate deterministic test adds an unprocessed source and
checks its explicit `unprocessed` label. Further tests reject corrupted source
bytes and foreign source snapshots before they can become injected context.
