import { validateSchema } from "../../memory/core/schema.mjs";
import { extractionTransport } from "./extraction-transport.mjs";

export class MemoryInferenceError extends Error {
  constructor(
    code,
    { retryable = false, transport = false, details = {} } = {},
  ) {
    super(`Memory inference ${code}`);
    this.name = "MemoryInferenceError";
    this.code = code;
    this.retryable = retryable;
    this.transport = transport;
    // Only fixed enums and nonnegative token counts may reach operational logs.
    const safe = {};
    for (const [key, allowed] of Object.entries({
      inference_stage: ["extract", "reconcile", "review"],
      response_status: [
        "completed",
        "failed",
        "in_progress",
        "cancelled",
        "queued",
        "incomplete",
      ],
      incomplete_reason: ["max_output_tokens", "content_filter"],
      validation_reason: [
        "claim_refs",
        "evidence_unique",
        "evidence_unknown",
        "current_evidence_required",
        "coverage_segments",
        "coverage_evidence",
        "coverage_missing",
        "required_text",
        "invalid_proposal",
      ],
    })) {
      if (allowed.includes(details[key])) safe[key] = details[key];
    }
    for (const key of [
      "input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "max_output_tokens",
    ]) {
      if (Number.isSafeInteger(details[key]) && details[key] >= 0)
        safe[key] = details[key];
    }
    Object.defineProperty(this, "details", {
      value: Object.freeze(safe),
      enumerable: true,
    });
  }
}

const boundedInteger = (value, name, maximum) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}`);
};

async function readJSON(response, maximum, signal) {
  if (!response.body) throw new MemoryInferenceError("empty response");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new MemoryInferenceError("response size exceeded");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createMemoryInferenceAPI({
  apiKey,
  model,
  reviewer = model,
  fetcher = fetch,
  timeoutMs = 120_000,
  maxOutputTokens = 18_000,
  maxPromptCharacters = 200_000,
  maxResponseBytes = 2_000_000,
  reasoningEffort = "medium",
}) {
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new TypeError("Memory inference API key is required");
  for (const name of [model, reviewer])
    if (typeof name !== "string" || !name.trim() || name.length > 200)
      throw new TypeError(
        "Explicit extraction and review model names are required",
      );
  boundedInteger(timeoutMs, "timeoutMs", 360_000);
  boundedInteger(maxOutputTokens, "maxOutputTokens", 32_000);
  boundedInteger(maxPromptCharacters, "maxPromptCharacters", 200_000);
  boundedInteger(maxResponseBytes, "maxResponseBytes", 4_000_000);
  if (
    reasoningEffort !== null &&
    !["none", "minimal", "low", "medium", "high", "xhigh"].includes(
      reasoningEffort,
    )
  )
    throw new TypeError("Unsupported reasoning effort");

  return {
    model,
    reviewer,
    extractionFormat: "source-groups-v1",
    async structured(stage, prompt, schema, { signal } = {}) {
      if (!["extract", "reconcile", "review"].includes(stage))
        throw new TypeError("Unknown inference stage");
      if (
        typeof prompt !== "string" ||
        !prompt.trim() ||
        prompt.length > maxPromptCharacters
      )
        throw new MemoryInferenceError("prompt size exceeded");
      signal?.throwIfAborted();
      const transport =
        stage === "extract" ? extractionTransport(schema) : null;
      const controller = new AbortController();
      let timeout;
      let onAbort;
      const stopped = new Promise((_, reject) => {
        onAbort = () => {
          controller.abort();
          reject(new MemoryInferenceError("cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        timeout = setTimeout(() => {
          controller.abort();
          reject(
            new MemoryInferenceError("timeout", {
              retryable: true,
              transport: true,
            }),
          );
        }, timeoutMs);
      });
      const selectedModel = stage === "review" ? reviewer : model;
      try {
        return await Promise.race([
          stopped,
          (async () => {
            let response;
            try {
              response = await fetcher("https://api.openai.com/v1/responses", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${apiKey.trim()}`,
                  "Content-Type": "application/json",
                },
                redirect: "error",
                signal: controller.signal,
                body: JSON.stringify({
                  model: selectedModel,
                  service_tier: "default",
                  store: false,
                  truncation: "disabled",
                  input: [{ role: "user", content: prompt }],
                  ...(reasoningEffort === null
                    ? {}
                    : { reasoning: { effort: reasoningEffort } }),
                  max_output_tokens: maxOutputTokens,
                  text: {
                    format: {
                      type: "json_schema",
                      name: `memory_${stage}`,
                      schema: transport?.schema ?? schema,
                      strict: true,
                    },
                  },
                }),
              });
            } catch {
              throw new MemoryInferenceError("transport failure", {
                retryable: true,
                transport: true,
              });
            }
            if (controller.signal.aborted) {
              await response.body?.cancel().catch(() => {});
              throw new MemoryInferenceError("cancelled");
            }
            if (!response.ok) {
              await response.body?.cancel().catch(() => {});
              const retryable =
                response.status === 429 || response.status >= 500;
              throw new MemoryInferenceError(`HTTP ${response.status}`, {
                retryable,
                transport: retryable,
              });
            }
            const raw = await readJSON(
              response,
              maxResponseBytes,
              controller.signal,
            );
            if (raw.status !== "completed") {
              const reason = raw.incomplete_details?.reason;
              const code =
                raw.status === "incomplete" && reason === "max_output_tokens"
                  ? "output token limit reached"
                  : raw.status === "incomplete" && reason === "content_filter"
                    ? "content filtered"
                    : raw.status === "failed"
                      ? "provider response failed"
                      : "incomplete response";
              throw new MemoryInferenceError(code, {
                details: {
                  response_status: raw.status,
                  incomplete_reason: reason,
                  input_tokens: raw.usage?.input_tokens,
                  output_tokens: raw.usage?.output_tokens,
                  reasoning_tokens:
                    raw.usage?.output_tokens_details?.reasoning_tokens,
                  max_output_tokens: maxOutputTokens,
                },
              });
            }
            const content = (raw.output ?? [])
              .filter((item) => item.type === "message")
              .flatMap((item) => item.content ?? []);
            if (content.some((item) => item.type === "refusal"))
              throw new MemoryInferenceError("refused");
            let value = JSON.parse(
              content
                .filter((item) => item.type === "output_text")
                .map((item) => item.text)
                .join(""),
            );
            if (transport) value = transport.decode(value);
            validateSchema(value, schema);
            const count = (name) =>
              Number.isSafeInteger(raw.usage?.[name]) && raw.usage[name] >= 0
                ? raw.usage[name]
                : 0;
            return {
              value,
              model: selectedModel,
              usage: {
                input_tokens: count("input_tokens"),
                output_tokens: count("output_tokens"),
              },
            };
          })(),
        ]);
      } catch (error) {
        if (error instanceof MemoryInferenceError)
          throw new MemoryInferenceError(error.code, {
            retryable: error.retryable,
            transport: error.transport,
            details: { ...error.details, inference_stage: stage },
          });
        throw new MemoryInferenceError("invalid response", {
          details: { inference_stage: stage },
        });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
