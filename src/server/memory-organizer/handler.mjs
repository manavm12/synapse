import {
  applyMemoryChangeSet,
  currentClaims,
  evidenceContextFor,
  prepareMemoryChangeSet,
  reconciliationSchema,
  segmentsFor,
  validateExtraction,
} from "../../memory/core/index.mjs";
import { validateSchema } from "../../memory/core/schema.mjs";
import { hash } from "../../memory/core/source.mjs";
import { MemoryInferenceError } from "./api.mjs";
import {
  extractionPrompt,
  PROMPT_VERSION,
  reconciliationPrompt,
  reviewPrompt,
  reviewSchema,
} from "./prompts.mjs";
import {
  extractionRepairFeedback,
  extractionSchemaFor,
  validationReason,
} from "./validation.mjs";

function catalogFor(ledger) {
  return currentClaims(ledger).map((claim) => ({
    id: claim.id,
    subject: claim.subject,
    aspect: claim.aspect,
    scope: claim.scope,
    assertion: claim.assertion,
    kind: claim.kind,
    topic: claim.topic,
    subtopic: claim.subtopic,
    observedAt: claim.observedAt,
    state: claim.state,
    evidence: claim.evidence.map((entry) => entry.segmentId),
    answeredBy: claim.answeredBy,
  }));
}

export function createMemoryOrganizerHandler({
  adapter,
  api,
  reviewStrategy = "always",
  maxStageCalls = 3,
  now = () => new Date(),
  signal: shutdownSignal,
}) {
  if (!["always", "never"].includes(reviewStrategy))
    throw new TypeError("reviewStrategy must be always or never");
  if (
    !Number.isInteger(maxStageCalls) ||
    maxStageCalls < 1 ||
    maxStageCalls > 3
  )
    throw new TypeError("maxStageCalls must be 1..3");
  if (
    typeof adapter?.loadSource !== "function" ||
    typeof adapter?.commit !== "function" ||
    typeof api?.structured !== "function"
  )
    throw new TypeError("A ledger adapter and inference API are required");

  return {
    async process(envelope, { signal: jobSignal } = {}) {
      const signals = [shutdownSignal, jobSignal].filter(Boolean);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      signal?.throwIfAborted();
      const { source, ledger } = await adapter.loadSource(envelope);
      const recordedAt = now().toISOString();
      const segments = segmentsFor(source);
      const catalog = catalogFor(ledger);
      const contextEvidence = evidenceContextFor(ledger);
      const sourceSchema = extractionSchemaFor(segments, contextEvidence);
      const calls = [];
      const stageCalls = { extract: 0, reconcile: 0, review: 0 };
      const request = async (stage, prompt, schema) => {
        if (prompt.length > (stage === "extract" ? 160_000 : 200_000))
          throw new MemoryInferenceError(
            "context limit reached; no truncation",
          );
        for (;;) {
          signal?.throwIfAborted();
          if (stageCalls[stage] >= maxStageCalls)
            throw new MemoryInferenceError(`${stage} call budget exhausted`);
          stageCalls[stage]++;
          const record = {
            stage,
            promptHash: hash(prompt),
            model: stage === "review" ? api.reviewer : api.model,
            outcome: "failed",
          };
          calls.push(record);
          try {
            const response = await api.structured(stage, prompt, schema, {
              signal,
            });
            signal?.throwIfAborted();
            validateSchema(response.value, schema);
            record.outcome = "completed";
            record.usage = response.usage;
            return response.value;
          } catch (error) {
            if (
              signal?.aborted ||
              !error.transport ||
              !error.retryable ||
              stageCalls[stage] >= maxStageCalls
            )
              throw error;
          }
        }
      };
      let extraction;
      let reconciliation;
      let feedback = "";
      let stage = "extract";
      for (let attempt = 1; attempt <= maxStageCalls; attempt++) {
        try {
          stage = "extract";
          extraction ??= await request(
            "extract",
            extractionPrompt(
              source,
              segments,
              catalog,
              feedback,
              contextEvidence,
            ),
            sourceSchema,
          );
          // These are local proposal keys, not model-derived facts. Assign
          // them before reconciliation/review sees the extraction. Repeating
          // this on a repair is idempotent; all prior proposals are uncommitted.
          extraction = {
            ...extraction,
            claims: extraction.claims.map((claim, index) => ({
              ...claim,
              ref: `c${index + 1}`,
            })),
          };
          validateExtraction(source, extraction, ledger);
          stage = "reconcile";
          if (catalog.length && extraction.claims.length) {
            const schema = structuredClone(reconciliationSchema);
            schema.properties.actions.items.properties.targets.items = {
              type: "string",
              enum: catalog.map((claim) => claim.id),
            };
            schema.properties.actions.items.properties.ref = {
              type: "string",
              enum: extraction.claims.map((claim) => claim.ref),
            };
            reconciliation = await request(
              "reconcile",
              reconciliationPrompt(
                catalog,
                extraction.claims.map((claim) => ({
                  ...claim,
                  observedAt: source.capturedAt,
                })),
                feedback.split("\nPrior extraction")[0],
              ),
              schema,
            );
          } else
            reconciliation = {
              actions: extraction.claims.map((claim) => ({
                ref: claim.ref,
                action: "add",
                targets: [],
                reason: "No live committed target exists for reconciliation",
              })),
            };
          const changeSet = prepareMemoryChangeSet({
            ledger,
            envelope: source,
            expectedIdentity: source,
            extraction,
            reconciliation,
            recordedAt,
          });
          stage = "review";
          let review = null;
          if (reviewStrategy === "always") {
            review = await request(
              "review",
              reviewPrompt(
                source,
                segments,
                catalog,
                extraction,
                reconciliation,
                feedback,
                contextEvidence,
                catalogFor(applyMemoryChangeSet(ledger, changeSet)),
              ),
              reviewSchema,
            );
            if (review.issues.length) {
              feedback = `Semantic review issues: ${JSON.stringify(review.issues)}\nPrior extraction and reconciliation: ${JSON.stringify({ extraction, reconciliation })}`;
              if (review.issues.some((issue) => issue.stage === "extraction"))
                extraction = undefined;
              if (attempt === maxStageCalls)
                throw new MemoryInferenceError(
                  "semantic review rejected proposal",
                );
              continue;
            }
          }
          return {
            changeSet,
            audit: {
              promptVersion: PROMPT_VERSION,
              extractionFormat: api.extractionFormat ?? "flat-v1",
              claimRefStrategy: "source-order-v1",
              reviewStrategy,
              reviewPassed: review !== null,
              maxStageCalls,
              stageCalls,
              calls,
            },
          };
        } catch (error) {
          if (signal?.aborted) throw new MemoryInferenceError("cancelled");
          if (
            error instanceof MemoryInferenceError ||
            attempt === maxStageCalls
          )
            throw error instanceof MemoryInferenceError
              ? error
              : new MemoryInferenceError(`${stage} validation failed`, {
                  details: {
                    inference_stage: stage,
                    validation_reason: validationReason(error),
                  },
                });
          const repair =
            stage === "extract"
              ? extractionRepairFeedback(error, extraction, segments)
              : error.message;
          feedback = `${repair}\nPrior extraction and reconciliation: ${JSON.stringify({ extraction, reconciliation })}`;
          if (stage === "extract") extraction = undefined;
        }
      }
      throw new MemoryInferenceError("call budget exhausted");
    },
    async commit(input) {
      if (
        input.result.audit?.reviewStrategy !== reviewStrategy ||
        (reviewStrategy === "always" &&
          input.result.audit.reviewPassed !== true)
      )
        throw new Error(
          "Memory organizer result did not satisfy configured review strategy",
        );
      return adapter.commit(input);
    },
  };
}
