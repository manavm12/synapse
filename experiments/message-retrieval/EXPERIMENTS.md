# Experiment protocol and audit trail

The primary experiment isolates retrieval from ingestion. The graph is authored
through the production core, and the gold rubric is authored before API trials.
Expected answers never appear in the inference inputs. The model receives the
peer message, bounded preceding conversation, navigation labels and tool results.

## Fixed fixture

- Primary graph SHA256: `35e8af2bff5b18f1dc69cd62312414c01e8a63a498b1b565255efe7984d6e098`.
- Message/gold SHA256: `1e28807efb9ee9f724872d8c9028f6131014abc96886023e02baf7c84653cb51`.
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
   error codes. Comparisons are ongoing; no winner is claimed at this checkpoint.

The first smoke and v1 run predate startup code-hash capture; formatting occurred
while v1 was running, so its recorded code hash is an end-of-run value. Version 2
and later record the startup runtime-code hash. These early development artifacts
are diagnostic only and will not be presented as frozen final evaluations.

## Interpretation

Score the exact evidence items present in the final rendered prompt. Required
facts may accept equivalent claim evidence. A source segment can support the
claims linked to that exact segment, while retaining its source-only label.
Record precision, completeness, no-answer abstention, invalid citations, wrong
status, tenant leakage, latency, tokens and cost. An unavailable result never
counts as a successful no-answer decision. Gates are fixed at 95% recall, 90%
complete answers, 80% precision, 95% abstention and zero integrity violations.

Failure-class heuristics in the JSON reports are triage hints. Inspect the saved
query/action trace and actual prompt to distinguish missed candidates from wrong
selection, source-only omissions or context packing. Preserve failed examples
and report remaining uncertainty rather than adjusting thresholds to obtain a pass.
