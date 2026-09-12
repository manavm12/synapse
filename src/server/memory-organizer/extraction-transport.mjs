import { choice, object, validateSchema } from "../../memory/core/schema.mjs";

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
  const claimGroup = object({
    claims: { type: "array", minItems: 1, items: claim },
  });
  const excludedGroup = object({
    nonClaimDisposition: choice("context", "untrusted", "boilerplate"),
    nonClaimReason: { type: "string", pattern: "\\S" },
  });
  const providerSchema = object({
    segments: object(
      Object.fromEntries(ids.map((id) => [id, { $ref: "#/$defs/group" }])),
    ),
  });
  // Definitions keep enums single-copy regardless of source segment count.
  providerSchema.$defs = {
    group: {
      anyOf: [
        object({
          claims: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/claim" },
          },
        }),
        excludedGroup,
      ],
    },
    claim,
  };
  return {
    schema: providerSchema,
    decode(value) {
      const localSchema = object({
        segments: object(
          Object.fromEntries(
            ids.map((id) => [
              id,
              Object.hasOwn(value?.segments?.[id] ?? {}, "claims")
                ? claimGroup
                : excludedGroup,
            ]),
          ),
        ),
      });
      validateSchema(value, localSchema);
      const claims = [];
      for (const id of ids) {
        const entries = value.segments[id].claims;
        // The small core schema validator does not implement minItems.
        if (entries?.length === 0)
          throw new Error("Empty claim group requires an explicit exclusion");
        for (const { additionalEvidence, ...assertion } of entries ?? []) {
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
