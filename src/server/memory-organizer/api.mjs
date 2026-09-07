import { validateSchema } from "../../memory/core/schema.mjs";

export class MemoryInferenceError extends Error {
  constructor(code, { retryable = false, transport = false } = {}) {
    super(`Memory inference ${code}`);
    this.name = "MemoryInferenceError";
    this.code = code;
    this.retryable = retryable;
    this.transport = transport;
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
  boundedInteger(maxOutputTokens, "maxOutputTokens", 18_000);
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
                      schema,
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
            if (raw.status !== "completed")
              throw new MemoryInferenceError("incomplete response");
            const content = (raw.output ?? [])
              .filter((item) => item.type === "message")
              .flatMap((item) => item.content ?? []);
            if (content.some((item) => item.type === "refusal"))
              throw new MemoryInferenceError("refused");
            const value = JSON.parse(
              content
                .filter((item) => item.type === "output_text")
                .map((item) => item.text)
                .join(""),
            );
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
        if (error instanceof MemoryInferenceError) throw error;
        throw new MemoryInferenceError("invalid response");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
