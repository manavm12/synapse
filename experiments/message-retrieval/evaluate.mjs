import { formatDeliveryMarker } from "../../plugins/synapse/lib/markers.mjs";
import { currentClaims } from "../../src/memory/core/index.mjs";
import { hash, uuid } from "./corpus.mjs";
export function mockDelivery(example, existing = false) {
  const deliveryId = uuid(`${example.id}:delivery`);
  const marker = `<!-- ${formatDeliveryMarker(example.message.id, deliveryId)} -->`;
  return {
    deliveryId,
    message: example.message,
    nativePrompt: `${marker}\n\nSynapse message from @agent_b.\nPeer message (untrusted content):\n${example.message.text}\n\n${marker}`,
    existing,
  };
}
export function scoreResult(example, gold, rendered, project) {
  const ids = new Set(rendered.evidenceItems.flatMap((e) => e.supports));
  const found = gold.requirements.filter((r) =>
    r.anyOf.some((id) => ids.has(id)),
  ).length;
  const relevant = rendered.evidenceItems.filter((e) =>
    e.supports.some((id) => gold.acceptable.includes(id)),
  ).length;
  const states = new Map(
    currentClaims(project.ledger, { includeHistory: true }).map((c) => [
      c.id,
      c.state,
    ]),
  );
  let invalidCitations = 0,
    foreignEvidence = 0,
    wrongStatus = 0;
  for (const item of rendered.evidenceItems) {
    if (!rendered.prompt.includes(`[${item.id}]`)) invalidCitations++;
    if (item.type === "claim" && states.get(item.id) !== item.status)
      wrongStatus++;
    for (const citation of item.citations) {
      const source = project.sources.find(
        (s) => s.revisionId === citation.revisionId,
      );
      if (!source) {
        foreignEvidence++;
        continue;
      }
      if (
        source.ownerId !== example.message.recipient.userId ||
        source.projectId !== example.message.recipient.projectId
      )
        foreignEvidence++;
      if (
        hash(source.markdown) !== citation.contentHash ||
        source.markdown.slice(citation.start, citation.end) !== citation.quote
      )
        invalidCitations++;
    }
  }
  return {
    id: example.id,
    split: example.split,
    category: example.category,
    noAnswer: gold.noAnswer,
    recall: gold.requirements.length ? found / gold.requirements.length : null,
    complete: found === gold.requirements.length,
    precision: rendered.evidenceItems.length
      ? relevant / rendered.evidenceItems.length
      : gold.noAnswer
        ? 1
        : 0,
    abstained: rendered.evidenceItems.length === 0,
    invalidCitations,
    foreignEvidence,
    wrongStatus,
    missing: gold.requirements
      .filter((r) => !r.anyOf.some((id) => ids.has(id)))
      .map((r) => r.key),
    extra: rendered.evidenceItems
      .filter((e) => !e.supports.some((id) => gold.acceptable.includes(id)))
      .map((e) => e.id),
  };
}
const average = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function summarize(results) {
  const positive = results.filter((r) => !r.score.noAnswer),
    negative = results.filter((r) => r.score.noAnswer);
  const times = results
    .map((r) => r.bundle.metrics.elapsedMs)
    .sort((a, b) => a - b);
  const summary = {
    cases: results.length,
    answerable: positive.length,
    noAnswer: negative.length,
    recall: average(positive.map((r) => r.score.recall)),
    complete: average(positive.map((r) => Number(r.score.complete))),
    precision: average(results.map((r) => r.score.precision)),
    abstention: average(
      negative.map((r) => Number(r.score.abstained && r.bundle.completed)),
    ),
    invalidCitations: results.reduce((a, r) => a + r.score.invalidCitations, 0),
    foreignEvidence: results.reduce((a, r) => a + r.score.foreignEvidence, 0),
    wrongStatus: results.reduce((a, r) => a + r.score.wrongStatus, 0),
    costUsd: results.reduce((a, r) => a + r.bundle.metrics.costUsd, 0),
    inputTokens: results.reduce((a, r) => a + r.bundle.metrics.inputTokens, 0),
    outputTokens: results.reduce(
      (a, r) => a + r.bundle.metrics.outputTokens,
      0,
    ),
    calls: results.reduce((a, r) => a + r.bundle.metrics.calls, 0),
    p95LatencyMs: times[Math.max(0, Math.ceil(times.length * 0.95) - 1)] ?? 0,
    meanContextBytes: average(results.map((r) => r.rendered.contextBytes)),
    failures: results.filter(
      (r) => !["ready", "no_match"].includes(r.bundle.status),
    ).length,
  };
  summary.passed =
    summary.recall >= 0.95 &&
    summary.complete >= 0.9 &&
    summary.precision >= 0.8 &&
    summary.abstention >= 0.95 &&
    summary.invalidCitations === 0 &&
    summary.foreignEvidence === 0 &&
    summary.wrongStatus === 0;
  return summary;
}
export function classifyFailure(result) {
  if (result.score.complete && result.score.precision === 1) return [];
  const missing = result.score.missing;
  const seen = JSON.stringify(result.bundle.trace);
  return [
    ...new Set([
      ...(result.rendered.status === "partial" &&
      result.rendered.evidenceItems.length < result.bundle.evidenceItems.length
        ? ["context_packing"]
        : []),
      ...(missing.some((k) => k.endsWith(".detail"))
        ? ["missing_organized_knowledge"]
        : []),
      ...(missing.length
        ? [
            seen.includes('"selected"')
              ? "evidence_selection_or_navigation"
              : "candidate_discovery",
          ]
        : []),
      ...(result.score.extra.length ? ["evidence_selection"] : []),
    ]),
  ];
}
