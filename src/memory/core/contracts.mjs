import { choice, object, records, strings, text } from "./schema.mjs";

export const extractionSchema = object({
  claims: records({
    ref: text,
    subject: text,
    aspect: text,
    scope: text,
    title: text,
    assertion: text,
    kind: choice(
      "fact",
      "decision",
      "procedure",
      "open_question",
      "reference",
      "change",
    ),
    status: choice("active", "disputed", "historical"),
    topic: text,
    subtopic: text,
    evidence: strings,
  }),
  coverage: records({
    segmentId: text,
    disposition: choice("claims", "context", "untrusted", "boilerplate"),
    reason: text,
  }),
});

export const reconciliationSchema = object({
  actions: records({
    ref: text,
    action: choice(
      "add",
      "equivalent",
      "replaces",
      "replaced_by",
      "resolves",
      "conflicts",
    ),
    targets: strings,
    reason: text,
  }),
});

export const CORE_VERSION = "claim-ledger-core-v1";
