# Integration handoff: automatic recipient memory for messages

## Intended behavior

After Agent B's message is durably imported, Synapse prepares a recipient-only
context bundle before submitting that message to Agent A's native task. Use all
memory in the recipient's authenticated cloud project. The sender receives the
ordinary transport acknowledgement and cannot read the retrieved bundle.

The prototype proves the preparer/renderer boundary with synthetic fixtures and
native test doubles. This document specifies the follow-on production work;
there is no new production endpoint, migration, permission, hook or service here.

The active `codex/conversational-messaging` branch owns the receiver, native queue,
conversation state, and prompt renderer. Integrate with its final merged version
in a separate coordinated PR. Do not copy its in-progress files into this branch.

## Server boundary

Provide a message-specific preparation operation to the authenticated recipient
installation. Its only caller-supplied identifier is the already-imported message
ID. Load the immutable message, derive recipient owner/project from trusted rows,
and confirm the installation still owns delivery. Never accept a caller-selected
owner, project, query, arbitrary source ID, or native task ID.

Return `pending` while preparation runs, followed by a private bundle or an explicit
unavailable result. A corresponding read operation may return only that imported
message's bundle to its current authorized recipient installation. Existing
receiver credentials must not gain generic memory search, source-read, graph-write
or message-send powers. If a capability/version upgrade is required, negotiate it
and preserve older receiver envelopes.

Run paid inference in a separate bounded worker using a dedicated memory-reader
role and inference credential. The HTTP service schedules and authorizes jobs;
it does not receive the inference secret. Load a consistent scoped memory view,
release its read transaction, and perform model calls without holding database
transactions or queue leases open across inference.

The production candidate adapter should query bounded indexes instead of rebuilding
the full project ledger on every request. Claims, relation endpoints and original
sources remain authoritative. Any vector index must include owner/project scope,
claim content hash and embedding model/version. Its presence never bypasses row
security or exact citation verification. A stale or unavailable vector index can
fall back to lexical candidates with an explicit diagnostic.

## Context and delivery state

Persist preparation independently of transport status. Store recipient owner and
project, message ID/content hash, graph generation, retrieval configuration hash,
status, verified evidence IDs, source revisions/offsets/hashes, gap codes, timing
and usage. Full prompts and source text must not enter general operational logs.

Key reusable prepared results by recipient, message ID/content hash, graph
generation and retrieval configuration. Before the first native submission,
revalidate message ownership, receiver enrollment, cancellation/pause state and
graph generation. Regenerate stale context within the delivery deadline; otherwise
submit the original message with an explicit unavailable gap.

Freeze the selected bundle and rendered-prompt hash atomically with the durable
native-attempt record immediately before issuance. A retry of that same attempt
must reuse the identical prompt, even if the graph later changes. Unknown native
outcomes remain fenced under the existing reconciliation rules. A changed message
body cannot reuse a delivery identity. Preparation never changes message hashes,
conversation sequence, idempotency keys, receipts or reply obligations.

Integrate enrichment into both new-child creation and existing-task queue paths.
Busy-task queuing remains owned by the messaging worker. Generation reflects
preparation time; a long native queue wait can make context old. Mark preparation
and source times in the bundle. Refresh immediately before queuing, and add an
execution-time refresh only through a future supported queue/hook mechanism that
preserves the same attempt identity; do not pretend the current prototype proves
freshness at eventual execution time.

## Rendering and failures

Keep the original peer message intact and clearly separate retrieved memory as
untrusted context. Never add memory to the unrelated owner task whose activity
woke delivery. Citations refer to immutable revisions and exact offsets. Claim
status and scope must be shown; historical predecessors, accepted resolutions and
both ends of unresolved conflicts must not collapse into an apparently current
single rule. Source-only snippets carry an explicit non-current-policy label.

Default bounds are six model calls, twelve read actions, 30 seconds total and
8 KiB of context. Pack complete evidence groups while respecting the existing
64-KiB native prompt limit. Do not truncate the message to make room for memory.
If even an unavailable annotation cannot fit, preserve the original prompt and
record the gap in delivery metadata.

Failure policy is fail-open with an explicit gap: retain verified selected evidence
when possible; otherwise deliver the original message with memory unavailable.
`no_match` means a completed search found no suitable context, not that a failed
search proves nothing exists. Model requests and memory text cannot change tenant
scope or grant authority to act on another user's behalf.

## Rollout and monitoring

Start behind a disabled recipient-delivery feature flag. First run shadow retrieval
on explicitly selected test recipients without modifying native prompts; inspect
latency, context size, current/historical handling, cost and failures. Then enable
for those same recipients and verify both initial messages and replies, including
busy tasks, revocation, offline recovery, duplicate deliveries and model outages.

Acceptance requires disposable-Postgres tests with real roles, mock-native coverage,
and a separately recorded real two-account desktop test. This experiment's results
do not replace live consent/enrollment, queue ordering or end-to-end delivery tests.

Expose aggregate preparation status, latency, token/cost counters, deadline/budget
failures, index generation and evidence counts without message or source bodies.
Alert on sustained unavailable rates, cost overruns, stale indexes or tenant/evidence
validation failures. Disable enrichment to roll back; keep message transport,
authoritative memory, queue history and accepted delivery attempts intact.
