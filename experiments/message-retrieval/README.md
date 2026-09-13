# Recipient memory retrieval laboratory

This isolated prototype enriches a mock incoming Synapse message with verified
memory from its recipient's project. It does not install hooks, send real messages,
change production tables, or deploy a worker. Existing production modules are
imported without modification.

Start with [RESULTS.md](RESULTS.md) for the scorecard and selected configuration,
[GRAPH.md](GRAPH.md) for the fixture, and [INTEGRATION.md](INTEGRATION.md) for the
recipient-side delivery handoff.

## Reproduce

Use Node 24 and the repository's pinned dependencies:

```sh
npm ci --ignore-scripts
node experiments/message-retrieval/cli.mjs seed
node experiments/message-retrieval/cli.mjs eval --strategy lexical --run my-lexical
node --test experiments/message-retrieval/retrieval.test.mjs
```

For live synthetic evaluations, supply `OPENAI_API_KEY` securely in the process
environment, then run:

```sh
node experiments/message-retrieval/cli.mjs eval --strategy agent --run my-agent
node experiments/message-retrieval/cli.mjs eval --strategy hybrid --run my-hybrid
node experiments/message-retrieval/cli.mjs budget
node experiments/message-retrieval/cli.mjs report
```

Every invocation uses the same `state/message-retrieval/spend.sqlite`: USD 3 for
development plus USD 2 for final evaluation, with a cumulative USD 5 ceiling.
Changing run names does not reset spending. Never delete or replace that ledger
to continue the same authorized experiment. Reservations survive crashes and
uncertain calls. The ceiling assumes verified standard-tier pricing, byte-based
input token bounds and provider output caps; it is not an account billing limit.
Prices are explicit in `budget.mjs` and must be reverified before future runs.
Credentials never belong in arguments, fixtures, captured output, or Git.

`--model gpt-5-mini --reasoning low` selects the development winner.
`--reasoning medium` is retained for reproducing development comparisons. `--limit`, `--offset`, and
`--concurrency` allow bounded development runs (maximum four concurrent cases).
`demo --strategy lexical` demonstrates one message without an API call. Each run
retains JSON traces, expected-versus-actual scores and the exact `.prompt.md` sent
to the native test double. Run names cannot overwrite earlier results.
`node experiments/message-retrieval/replay.mjs mini-dev-v9` reproduces retained
model decisions and exact prompts without API calls; it is not an independent trial.

Before evaluating held-out messages:

```sh
node experiments/message-retrieval/cli.mjs freeze --name finalists
node experiments/message-retrieval/cli.mjs eval --split heldout --freeze finalists --strategy agent --run final-agent
```

The freeze binds experiment and imported production code, package lock, graph,
benchmark, configuration version, and allowed model/strategy/reasoning settings.
Held-out runs fail if those change. Repeat runs are fresh model calls; only
embeddings are cached. Gold evidence never enters the model request.

## Fixture and adapters

The synthetic HarborDesk graph has 204 claims in 31 accepted source revisions,
eight top-level topics, and twenty scenario families. Forty development messages
and forty held-out messages use disjoint subjects. There are 32 answerable and
eight no-answer cases in each split. Claims use authored proposals and the
production deterministic reducer; no inference is spent constructing the graph.
Source-only operational facts deliberately test fallback beyond organized claims.

A second graph belongs to another owner and contains tempting contrary values.
A third deliberately impossible alternate-project snapshot tests extra project
fencing in the file adapter. Production currently permits one project per owner,
so only the first two are seeded through SQL. No real customer data is copied.

`seed` writes a reconstructable graph, messages, expected evidence and a Markdown
graph inspection report into the ignored state directory. Canonical fictional
facts, exact source envelopes, authored proposals, messages and expected evidence
are retained as JSON under `fixtures/`; tests compare reconstruction against them.
`FIXTURE_HASHES.json` identifies every fixture. Generated ledgers, vector caches,
code snapshots, run traces and actual prompts stay in ignored local state.
`createRepository` accepts either an in-memory corpus or the generated graph file.

The PostgreSQL test creates and drops its own database, applies existing migrations,
and commits both graphs through the real queue fences and organizer adapter. It
then verifies exact graph equality, runtime-role reads and cross-tenant denial.
Supply `TEST_DATABASE_URL` only for a disposable PostgreSQL 17 instance and set
`DATABASE_SSL=disable` only for that local database. Without the variable the SQL
test reports a skip. Full repository checks must use a fresh disposable database.

## Implementation boundaries

- `createMessageContextPreparer` returns the injectable
  `prepareMessageContext(trustedRecipient, message, conversationContext, limits)`.
- `renderMessagePrompt` verifies binding and keeps the original peer message and
  terminal receipt intact. It returns the actual injected items for scoring.
- Claims and quotes are selected by observed identifiers. Authoritative source
  hashes, offsets and owner/project scope are checked before evidence is rendered.
- A typed interpretation plan identifies recipient topics, scopes and requested
  aspects. Its executor and a bounded structured-action loop search, browse, read, follow recorded
  relations and searches source segments. The hybrid strategy combines lexical
  and cached embedding ranks. These experimental actions are not public MCP tools.
- `ready`, `partial`, `no_match`, and `unavailable` are different outcomes. Failed
  retrieval is not scored as successful abstention. Explicit conflicts and
  historical successors travel as indivisible context groups.
- `createDeliverySession` models retry freezing in memory. Production needs a
  durable equivalent; this helper is not an exactly-once delivery guarantee.

The acceptance rubric measures the final injected prompt: 95% mean required
recall, 90% complete answerable cases, 80% mean precision, 95% valid no-answer
abstention, and zero bad citations, tenant leaks or mislabeled claim statuses.
These are synthetic-fixture gates, not a claim of general semantic recall.

Model/API references: [nano](https://developers.openai.com/api/docs/models/gpt-5-nano),
[mini](https://developers.openai.com/api/docs/models/gpt-5-mini),
[embeddings](https://developers.openai.com/api/docs/models/text-embedding-3-small),
[structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).


The provider follows the existing organizer's Responses conventions (strict JSON,
standard tier, store disabled, bounded output), but uses an isolated transport:
that adapter only accepts organizer stages and is owned by another active branch.
Durable accounting also needs to cover embeddings and uncertain calls. Production
integration should coordinate a shared transport rather than copy this experiment
into the organizer. See `INTEGRATION.md` and `EXPERIMENTS.md` for boundaries.
