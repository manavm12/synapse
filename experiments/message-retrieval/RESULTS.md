# Recipient message memory: experiment results

The retained prototype meets the specified synthetic quality gates with **gpt-5-mini graph retrieval, low reasoning**. Both frozen held-out runs recovered every required fact on all 32 answerable messages and abstained on all eight no-answer messages. Production integration remains a separate workstream.

The selected architecture interprets the message into recipient topics, scopes and requested aspects; executes bounded lexical search, topic reads, recorded relation traversal and source fallback; then selects evidence IDs. Code resolves authoritative records and verifies exact citations before packing the native prompt. The current production retrieval service remains deterministic lexical search; automatic enrichment exists in this isolated prototype.

## Development selection

Each row used the same 40 messages and graph. Expected evidence was authored before trials and kept outside all model inputs. Mini graph was the only configuration meeting all development gates and was selected before held-out evaluation.

| Configuration | Recall | Complete | Precision: macro / pooled | Abstention | USD/message | Gates |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Lexical | 50.05% | 37.50% | 16.29% / 17.06% | 0.00% | $0.000000 | Fail |
| Nano graph | 94.79% | 87.50% | 72.17% / 44.12% | 62.50% | $0.000553 | Fail |
| Nano hybrid | 93.12% | 84.38% | 89.03% / 74.68% | 87.50% | $0.000532 | Fail |
| Mini graph | 96.88% | 96.88% | 91.83% / 86.11% | 100.00% | $0.001960 | Pass |

## Frozen held-out evaluation

Each row has 40 cases: 32 answerable and eight no-answer. The repeat used fresh model calls. Code, model settings, corpus and rubric were frozen; there was no tuning against held-out results.

| Configuration | Recall | Complete | Precision: macro / pooled | Abstention | USD/message | Gates |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Lexical | 43.02% | 31.25% | 14.76% / 15.05% | 0.00% | $0.000000 | Fail |
| Nano graph | 92.71% | 87.50% | 69.55% / 45.67% | 37.50% | $0.000565 | Fail |
| Nano hybrid | 92.71% | 87.50% | 71.76% / 58.00% | 62.50% | $0.000580 | Fail |
| Mini graph — primary | 100.00% | 100.00% | 92.71% / 86.49% | 100.00% | $0.001995 | Pass |
| Mini graph — repeat | 100.00% | 100.00% | 90.63% / 83.12% | 100.00% | $0.001959 | Pass |

Both selected runs also exceed 80% pooled precision, so their passes do not depend on giving empty negative cases macro precision 1. All five held-out runs had **zero invalid citations, cross-recipient disclosures, wrong statuses or wrong scopes**. Exact source hashes, segment identities and quote offsets are checked; the scorer checks the final rendered citation blocks and evidence labels.

The mini primary injected 74 evidence records: 64 relevant and 10 extra. The repeat injected 77: 64 relevant and 13 extra. Extra truthful context, especially adjacent resolutions and source details, remains the main precision issue. A passing threshold is not perfect selection.

## Latency, size, models and cost

| Mini graph | Primary | Repeat |
| --- | ---: | ---: |
| Mean retrieval latency | 9.05 s | 8.91 s |
| p95 retrieval latency | 15.41 s | 14.87 s |
| Model calls / message | 2.25 | 2.20 |
| Input tokens / message | 4084.4 | 4211.0 |
| Output tokens / message | 486.9 | 453.4 |
| Mean injected bytes | 997.0 | 1029.9 |
| Cost / message | $0.001995 | $0.001959 |

Returned versions were `gpt-5-mini-2025-08-07`, `gpt-5-nano-2025-08-07`, and `text-embedding-3-small`. Final Responses settings: low reasoning, standard service tier, `store=false`, strict JSON, 2,048 output tokens for planning and 4,096 for selection. Defaults remain six model calls, twelve read actions, a 30-second deadline and 8 KiB injected context. Mini used two concurrent cases; each nano control used one. These timings measure retrieval on this local fixture, not native task execution or transport acknowledgement.

**Total charged or conservatively reserved: $1.135523 of $5.** Development consumed $0.931534357 of its $3 allocation; final evaluation consumed $0.203988161 of its $2 reserve. This includes every failed development trial. Settled usage totals $0.858725367; 41 uncertain development requests retain $0.276797151 in reservations. There were no uncertain final requests. These are token-rate estimates and conservative reservations, not an invoice.

Embedding usage across indexing and all experiments was 7,665 tokens, $0.000153302. Per-message hybrid costs include query embeddings when uncached; fixture-index setup is covered by the cumulative ledger. Vector caches were reused. The SQL ledger persists reservations before sending requests and includes Responses, embeddings and uncertain outcomes across processes and restarts.

## Failure analysis and architecture choice

- **Candidate discovery:** mini missed one development paraphrase about saved recovery copies by planning against attachment recovery instead of database snapshots. No required evidence was missed in either selected held-out run.
- **Navigation:** broader early loops mixed scopes and did not reliably reach historical predecessors. Typed scope/aspect plans and explicit recorded relations substantially improved development recall. Nano still omitted historical or cross-topic facts.
- **Evidence selection:** nano often included adjacent facts or substituted current information for unknown regions/future policies. The frozen nano controls fail multiple gates. Mini still includes some unnecessary resolutions or source details.
- **Context packing:** the final mini runs lost no required evidence to packing. Deterministic tests verify native size limits and that conflict/supersession groups remain together. Early broad selections could waste most of the context budget.
- **Missing organized knowledge:** operational details deliberately exist only in source segments. Both selected held-out runs recovered their required source-only details, with explicit non-current-policy labels. Some nano runs failed this fallback.

Hybrid combines the top 20 lexical and top 20 semantic candidates with reciprocal-rank fusion (k=60), followed by the same agent and topic navigation. The nano-versus-nano comparison isolates that addition: embeddings did not bring the smaller model through the quality gates. This fixture's twenty subject subtopics give the planner a useful directory; the result does not establish that semantic indexes are unnecessary for larger or less organized memories.

Early schema-alias and malformed-action failures remain retained and are documented in [EXPERIMENTS.md](EXPERIMENTS.md). They are not evidence about retrieval quality. The reference task [Plan session memory graphing](codex://threads/01a0753c-ff61-7951-9b7c-d2a2fabb33c9) supplied architectural lessons; its historical 28/34 score was not used as this baseline.

## Reproduce and inspect

```sh
cd /Users/manavmehta/synapse-message-retrieval
node experiments/message-retrieval/cli.mjs seed
node experiments/message-retrieval/replay.mjs mini-heldout-v9
node experiments/message-retrieval/replay.mjs mini-heldout-repeat-v9
```

Replay uses retained local decisions and cached embeddings, makes zero API calls and reproduces exact prompts. For a new live demo, supply `OPENAI_API_KEY` in the process environment and run:

```sh
node experiments/message-retrieval/cli.mjs demo --strategy agent --model gpt-5-mini --reasoning low --run my-message-demo
```

All invocations share the retained spending ledger; do not reset it. A fresh checkout can rebuild the graph from committed sources and authored proposals, then run a new bounded evaluation. Exact prior Responses decisions and full prompts are local artifacts, not committed fixtures.

- [Graph inspection](GRAPH.md), [fixture hashes](FIXTURE_HASHES.json), [frozen selection](SELECTION.json), [machine-readable scores and run digests](RESULTS.json).
- Local graph: `state/message-retrieval/graph.json`; full projection: `state/message-retrieval/graph.md`.
- Side-by-side actual prompts: `state/message-retrieval/side-by-side.html`.
- Every case: `state/message-retrieval/runs/<run>/<case>.json` and `.prompt.md`.
- Runtime and dependency snapshots: `state/message-retrieval/code/<hash>/`.
- [Concrete messaging integration handoff](INTEGRATION.md).

## Post-benchmark release verification

Engineering review then repaired two boundary cases: markerless prompts at the
native size limit, and transitive companion expansion when an included successor
has a conflict. Retrieval model inputs and settings were unchanged. All 360 saved
v9 prompts replayed identically after these repairs. The original paid-trial code
snapshot remains retained; [RELEASE_VERIFICATION.json](RELEASE_VERIFICATION.json)
records the separate release snapshot and deterministic verification. No new paid
model trials are attributed to the patched release.

## Validation and remaining limits

`npm run check`: **288 passed, zero skipped**, including disposable PostgreSQL migrations, real storage adapters and row-security checks. Coverage: 95.70% lines, 86.73% branches, 94.21% functions. `npm run audit`: zero vulnerabilities. All nine final-development and held-out runs replayed to 360 identical prompts with no API calls.

The tests cover tenant isolation, source verification, malformed actions, timeouts, generation changes, multibyte and native prompt limits, duplicate delivery, and new/existing task routing through native doubles. Actual two-account desktop delivery, live queue behavior and Windows/macOS cross-device execution were not performed. No receiver hook, production endpoint, migration or permission was changed.

The graph is fictional and uses authored ingestion proposals with regular subject/aspect metadata. The 40 held-out messages share the project's vocabulary and scenario templates with development despite using disjoint families. This demonstrates the retrieval boundary and a promising configuration; it does not measure organizer errors, realistic long-session graphs, large-project scaling or downstream agent answer quality.
