# Experiment protocol and audit trail

The primary experiment isolates retrieval from ingestion. The graph is authored
through the production core, and the gold rubric is authored before API trials.
Expected answers never appear in the inference inputs. The model receives the
peer message, bounded preceding conversation, navigation labels and tool results.

## Fixed fixture

- Primary graph SHA256: `35e8af2bff5b18f1dc69cd62312414c01e8a63a498b1b565255efe7984d6e098`.
- Full message/gold SHA256: `09b9c82159f8b7439ea4673f00d0f3297acd2e84721cd932f6d4436cff79ad2f`.
- Original semantic rubric SHA256 remains `1e28807efb9ee9f724872d8c9028f6131014abc96886023e02baf7c84653cb51`. Before final evaluation, explicit expected types, states, scopes and prohibited IDs were added; no requested facts or acceptable IDs changed.
- 204 claims, 31 sources, eight root topics; 40 development and 40 held-out cases.
- Development and held-out families have different subjects but share the same
  fictional project graph, as real messages would. No held-out results are used
  to tune the retriever. The single-project/template construction limits external
  validity; this is not a statistically representative deployment benchmark.

## Development audit

1. Lexical baseline: original incoming text, existing production scoring, five
   returned claims and evidence companions, with the same final renderer.
2. First agent run exposed action IDs being confused with memory IDs. Its
   52.86% recall and 47.51% precision did not meet the quality gates.
3. Version 2 added observed-ID schema constraints, but a shared schema object
   accidentally aliased gap-code and selection enums. Both v2 comparisons failed
   and are retained as implementation failures, not architecture evidence. A
   schema regression test now prevents this defect.
4. Version 3 uses independent schemas and bounds selectable IDs to observations.
   Provider failures retain their monetary reservations and expose only allowlisted
   error codes. Mini graph reached 88.54% recall; nano hybrid reached 84.38%.
5. Versions 4–7 tried planning before search, typed action alternatives, temporary
   wire handles, separate retrieve/finish steps, and medium reasoning. The larger
   reasoning budget increased deadlines and did not solve subject/facet confusion.
6. Version 8 separated interpretation into a structured topic/scope/aspect plan.
   Code executes bounded search, recorded topic reads and relation traversal before
   final evidence selection. Source-only details are recovered separately.
7. Version 9 makes status/scope and exact rendered citation checks explicit. Mini
   graph passed development gates: 96.875% recall, 96.875% completeness, 91.833%
   macro precision, 100% abstention, no integrity violations. Nano graph and hybrid
   did not meet all gates. The selected configuration is mini graph, low reasoning.
8. Before freezing, gap-code validation, exact citation-block scoring, failure
   classification and code snapshot bookkeeping were tightened. Offline replay of
   all four v9 development runs produced 160 identical prompts and made no API calls.
   The final freeze also hashes imported production code and the package lock.

The first smoke and v1 run predate startup code-hash capture; formatting occurred
while v1 was running, so its recorded code hash is an end-of-run value. Version 2
and later record the startup runtime-code hash. These early development artifacts
are diagnostic only and will not be presented as frozen final evaluations.

## Interpretation

Score the exact evidence items present in the final rendered prompt. Required
facts may accept equivalent claim evidence. The final rubric requires the expected evidence type, state and scope. A source-only
quote does not receive credit for an authoritative current claim merely because
its text overlaps. Source-only requirements accept their designated exact segments.
Record precision, completeness, no-answer abstention, invalid citations, wrong
status, tenant leakage, latency, tokens and cost. An unavailable result never
counts as a successful no-answer decision. Gates are fixed at 95% recall, 90%
complete answers, 80% precision, 95% abstention and zero integrity violations.

Failure-class heuristics in the JSON reports are triage hints. Inspect the saved
query/action trace and actual prompt to distinguish missed candidates from wrong
selection, source-only omissions or context packing. Preserve failed examples
and report remaining uncertainty rather than adjusting thresholds to obtain a pass.


## Frozen evaluation policy

SELECTION.json was recorded before paid held-out evaluation. It chooses mini graph
from development gates and freezes all comparison settings. Evaluate each of the
four controls on 40 held-out cases, then repeat the selected mini configuration
once with fresh Responses calls. Report primary and repeat independently; a failed
run remains a failure. Do not tune against held-out results or substitute a newly
chosen model because it happened to score better there.

Precision in the automated gate is the macro average across cases, with an empty
negative case receiving precision 1 and an empty positive receiving 0. The final
report also gives pooled evidence precision so that empty outputs cannot hide
irrelevant injected records. Integrity checks require zero invalid citations,
foreign-recipient evidence, wrong statuses and wrong scopes.

Topic browsing supplements ranked search candidates in both agent variants. Hybrid
uses top-20 lexical and top-20 semantic candidates with RRF (k=60), then the same
scoped navigation and selection. Because the fixture has only twenty named subject
subtopics, the directory is informative; this experiment cannot establish that
embeddings are unnecessary for large, unfamiliar or poorly organized projects.


## Post-benchmark engineering review

After all paid trials completed, review found a markerless prompt could exceed the
native limit by two separator bytes. The renderer now counts those bytes inside
the context budget and preserves a full-size original unchanged. Companion
expansion also follows newly added successors' recorded conflicts, closing a gap
in the historical-selection boundary. These fixes do not alter retrieval model
inputs or settings. All 360 saved v9 cases replayed to identical native prompts.

The paid benchmark's original code snapshot remains frozen and retained.
RELEASE_VERIFICATION.json separately records the release source snapshot, these
engineering changes and replay evidence; it does not claim additional paid model
trials occurred on the patched release. Deterministic tests cover both edges.
