import {
  choice,
  object,
  text,
  validateSchema,
} from "../../memory/core/schema.mjs";

// The public handler/core contract stays flat. On the provider wire, every
// current segment is a required object key. A claim's group is its primary
// evidence selection; the model need not reproduce that ID on every claim or
// calculate a second, potentially contradictory coverage table.
export function extractionTransport(flatSchema) {
  const ids = flatSchema.properties.coverage.items.properties.segmentId.enum;
  if (!ids?.length) return null;
  const properties = flatSchema.properties.claims.items.properties;
  const claim = object({
    ...Object.fromEntries(
      Object.entries(properties).filter(
        ([key]) => !["ref", "evidence"].includes(key),
      ),
    ),
    additionalEvidence: {
      type: "array",
      items: structuredClone(properties.evidence.items),
    },
  });
  const group = object({
    claims: { type: "array", items: claim },
    nonClaimDisposition: choice("context", "untrusted", "boilerplate"),
    nonClaimReason: text,
  });
  const localSchema = object({
    segments: object(Object.fromEntries(ids.map((id) => [id, group]))),
  });
  const providerSchema = object({
    segments: object(
      Object.fromEntries(ids.map((id) => [id, { $ref: "#/$defs/group" }])),
    ),
  });
  // Definitions keep enums single-copy regardless of source segment count.
  providerSchema.$defs = {
    group: {
      ...group,
      properties: {
        ...group.properties,
        claims: { type: "array", items: { $ref: "#/$defs/claim" } },
      },
    },
    claim,
  };
  return {
    schema: providerSchema,
    decode(value) {
      validateSchema(value, localSchema);
      const claims = [];
      for (const id of ids) {
        for (const { additionalEvidence, ...assertion } of value.segments[id]
          .claims) {
          claims.push({
            ref: `c${claims.length + 1}`,
            ...assertion,
            evidence: [...new Set([id, ...additionalEvidence])],
          });
        }
      }
      const cited = new Set(claims.flatMap((entry) => entry.evidence));
      const coverage = ids.map((id) => ({
        segmentId: id,
        disposition: cited.has(id)
          ? "claims"
          : value.segments[id].nonClaimDisposition,
        reason: cited.has(id)
          ? "Cited by extracted claims"
          : value.segments[id].nonClaimReason,
      }));
      const result = { claims, coverage };
      // Includes the total 200-claim bound across groups; never truncate.
      validateSchema(result, flatSchema);
      return result;
    },
  };
}
