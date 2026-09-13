import { formatDeliveryMarker } from "../../plugins/synapse/lib/markers.mjs";
import { currentClaims, segmentsFor } from "../../src/memory/core/index.mjs";
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
  const escapeText = (text) =>
    text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const present = (item) =>
    rendered.prompt.includes(
      `[${item.id}] ${item.status}; scope: ${escapeText(item.scope)}`,
    ) &&
    rendered.prompt.includes(escapeText(item.assertion)) &&
    item.citations.every((c) =>
      rendered.prompt.includes(
        `Evidence ${c.revisionId} / ${c.segmentId} [${c.start},${c.end}) SHA256 ${c.contentHash}\n> ${escapeText(c.quote)}\n`,
      ),
    );
  const matches = (item, expected) =>
    present(item) &&
    item.id === expected.id &&
    item.type === expected.type &&
    item.status === expected.status &&
    item.scope === expected.scope;
  const satisfies = (requirement) =>
    rendered.evidenceItems.some((item) =>
      requirement.expected.some((expected) => matches(item, expected)),
    );
  const found = gold.requirements.filter(satisfies).length;
  const isRelevant = (item) =>
    gold.acceptableEvidence.some((expected) => matches(item, expected));
  const relevant = rendered.evidenceItems.filter(isRelevant).length;
  const states = new Map(
    currentClaims(project.ledger, { includeHistory: true }).map((c) => [
      c.id,
      c,
    ]),
  );
  let invalidCitations = 0,
    foreignEvidence = 0,
    wrongStatus = 0,
    wrongScope = 0;
  for (const item of rendered.evidenceItems) {
    if (!present(item)) invalidCitations++;
    if (item.type === "claim" && states.get(item.id)?.state !== item.status)
      wrongStatus++;
    if (item.type === "claim" && states.get(item.id)?.scope !== item.scope)
      wrongScope++;
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
      const segment = segmentsFor(source).find(
        (s) => s.id === citation.segmentId,
      );
      if (
        !segment ||
        citation.start < segment.start ||
        citation.end > segment.end ||
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
    wrongScope,
    prohibitedEvidence: rendered.evidenceItems.filter((e) =>
      gold.prohibited.ids.includes(e.id),
    ).length,
    missing: gold.requirements.filter((r) => !satisfies(r)).map((r) => r.key),
    extra: rendered.evidenceItems
      .filter((e) => !isRelevant(e))
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
    wrongScope: results.reduce((a, r) => a + (r.score.wrongScope ?? 0), 0),
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
    summary.wrongStatus === 0 &&
    summary.wrongScope === 0;
  return summary;
}
export function classifyFailure(result, gold) {
  const classes = new Set();
  const visible = new Set(),
    retrieved = new Set();
  let afterCandidates = false;
  for (const step of result.bundle.trace) {
    if (step.candidates) afterCandidates = true;
    for (const item of step.candidates ?? []) visible.add(item.id);
    for (const item of Array.isArray(step.result) ? step.result : []) {
      if (item?.id) {
        retrieved.add(item.id);
        if (afterCandidates) visible.add(item.id);
      }
      if (item?.fromClaim?.id) visible.add(item.fromClaim.id);
      if (item?.toClaim?.id) visible.add(item.toClaim.id);
    }
  }
  for (const key of result.score.missing) {
    const ids = gold?.requirements.find((r) => r.key === key)?.anyOf ?? [];
    if (ids.some((id) => result.bundle.evidenceItems.some((e) => e.id === id)))
      classes.add("context_packing");
    else if (ids.some((id) => visible.has(id)))
      classes.add("evidence_selection");
    else if (ids.some((id) => retrieved.has(id))) classes.add("navigation");
    else classes.add("candidate_discovery");
    if (key.endsWith(".detail") && !ids.some((id) => visible.has(id)))
      classes.add("missing_organized_knowledge");
  }
  if (result.score.extra.length) classes.add("evidence_selection");
  return [...classes];
}
