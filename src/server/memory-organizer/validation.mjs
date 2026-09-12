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
