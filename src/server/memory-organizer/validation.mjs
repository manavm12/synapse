import { extractionSchema } from "../../memory/core/index.mjs";
import { MemoryInferenceError } from "./api.mjs";

export function extractionSchemaFor(segments, contextEvidence) {
  const schema = structuredClone(extractionSchema);
  const current = [...new Set(segments.map((segment) => segment.id))];
  const known = [
    ...new Set([...current, ...contextEvidence.map((segment) => segment.id)]),
  ];
  // Responses permits 1000 enum values total and 15000 characters in a
  // string enum with more than 250 values. The static schema uses 13 values.
  if (
    known.length + current.length + 13 > 1000 ||
    (known.length > 250 && known.join("").length > 15_000)
  )
    throw new MemoryInferenceError("context limit reached; no truncation", {
      details: { inference_stage: "extract" },
    });
  // Assign new leaves: the base schema deliberately shares its text schema.
  // Empty sources keep the base shape; core validation still forbids claims
  // without current evidence and requires exactly the current coverage set.
  if (known.length)
    schema.properties.claims.items.properties.evidence = {
      type: "array",
      minItems: 1,
      items: { type: "string", enum: known },
    };
  if (current.length)
    schema.properties.coverage.items.properties.segmentId = {
      type: "string",
      enum: current,
    };
  return schema;
}

// Translate trusted validator messages to fixed operational codes. Never put
// the message itself in logs: it can contain arbitrary model-supplied IDs.
export function validationReason(error) {
  const message = error?.message;
  const exact = {
    "Claim refs must be unique c1, c2, etc": "claim_refs",
    "Each claim needs unique evidence segment IDs": "evidence_unique",
    "A new claim must cite its current source, not only previous context":
      "current_evidence_required",
    "Unknown or duplicate coverage segment": "coverage_segments",
    "Coverage disposition disagrees with claim evidence": "coverage_evidence",
    "Every source segment requires a coverage disposition": "coverage_missing",
  };
  if (Object.hasOwn(exact, message)) return exact[message];
  if (
    typeof message === "string" &&
    message.startsWith("Unknown evidence segment ")
  )
    return "evidence_unknown";
  if (
    /^(subject|aspect|scope|title|assertion|topic|Coverage reason) must not be empty$/.test(
      message,
    )
  )
    return "required_text";
  return "invalid_proposal";
}

// Repair feedback is model input, never operational error/audit output. List
// every affected CURRENT segment so a small model need not rediscover which
// citation/coverage relationship caused a generic validator rejection.
export function extractionRepairFeedback(error, extraction, segments) {
  const reason = validationReason(error);
  if (
    !extraction ||
    (!reason.startsWith("coverage_") &&
      reason !== "evidence_unique" &&
      reason !== "current_evidence_required")
  )
    return error.message;
  const currentIds = new Set(segments.map((segment) => segment.id));
  const evidenceIssues = extraction.claims.flatMap((claim) => {
    const empty = claim.evidence.length === 0;
    const duplicate = new Set(claim.evidence).size !== claim.evidence.length;
    const currentMissing = !claim.evidence.some((id) => currentIds.has(id));
    return empty || duplicate || currentMissing
      ? [{ ref: claim.ref, empty, duplicate, currentMissing }]
      : [];
  });
  const issues = segments.flatMap(({ id }) => {
    const entries = extraction.coverage.filter(
      (entry) => entry.segmentId === id,
    );
    const citingRefs = extraction.claims
      .filter((claim) => claim.evidence.includes(id))
      .map((claim) => claim.ref);
    if (
      entries.length === 1 &&
      (entries[0].disposition === "claims") === citingRefs.length > 0
    )
      return [];
    return [
      {
        segmentId: id,
        coverageEntries: entries.length,
        citingRefs,
        dispositions: entries.map((entry) => entry.disposition),
      },
    ];
  });
  return `${error.message}. Evidence consistency issues: ${JSON.stringify(evidenceIssues)}
Coverage consistency issues: ${JSON.stringify(issues)}
Every claim requires nonempty unique evidence IDs and at least one current source citation.
Give each current segment exactly one entry; remove unknown or duplicate coverage entries.
A cited segment MUST have disposition claims, including contextual evidence cited by a claim.
An uncited segment CANNOT have disposition claims. Extract any missing durable assertions with
their actual supporting citations, or use a justified non-claims disposition only if the
segment contains no independent durable assertion. Never add an unsupported citation merely
to satisfy coverage. Preserve all still-supported claims and evidence.`;
}
