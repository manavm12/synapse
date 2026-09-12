import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash } from "./corpus.mjs";

const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const text = { type: "string" };
const strings = { type: "array", items: text };
export const actionSchema = object({
  actions: {
    type: "array",
    items: object({
      op: {
        type: "string",
        enum: ["search", "topics", "read", "relations", "sources"],
      },
      query: text,
      id: text,
    }),
  },
  selected: strings,
  done: { type: "boolean" },
  gaps: strings,
});
export function createProvider({
  budget,
  apiKey,
  model = "gpt-5-nano",
  embeddingDirectory,
}) {
  const usage = [];
  async function infer(input, { signal } = {}) {
    const schema = structuredClone(actionSchema);
    const knownIds = input.data.knownIds ?? [];
    const targets = [
      ...new Set([
        "",
        "root",
        ...knownIds,
        ...(input.data.navigationIds ?? []),
      ]),
    ];
    schema.properties.actions.items.properties.id = {
      type: "string",
      enum: targets,
      description:
        "Exact existing memory target ID for read/relations/topics. Empty for search/sources. Never an action name.",
    };
    schema.properties.actions.items.properties.query = {
      type: "string",
      description:
        "Focused lexical/semantic search terms for search/sources; empty for read/relations/topics.",
    };
    schema.properties.selected.items = {
      type: "string",
      enum: knownIds.length ? knownIds : [""],
      description: "Exact evidence ID observed in candidates/results.",
    };
    schema.properties.gaps.items = {
      type: "string",
      enum: ["missing_evidence", "unsupported_scope", "ambiguous_scope"],
    };
    const result = await budget.request(
      "responses",
      {
        model,
        store: false,
        service_tier: "default",
        reasoning: { effort: "low" },
        max_output_tokens: 2048,
        truncation: "disabled",
        input: [
          { role: "developer", content: input.instructions },
          { role: "user", content: JSON.stringify(input.data) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "retrieval_actions",
            strict: true,
            schema,
          },
        },
      },
      { apiKey, signal },
    );
    usage.push(result.metrics);
    if (result.data.status !== "completed")
      throw new Error("incomplete_model_response");
    const text = result.data.output
      ?.flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("");
    return JSON.parse(text);
  }
  async function embed(texts, { signal } = {}) {
    mkdirSync(embeddingDirectory, { recursive: true });
    const result = new Array(texts.length),
      missing = [];
    for (const [i, text] of texts.entries()) {
      const key = hash({ model: "text-embedding-3-small", text });
      const path = join(embeddingDirectory, `${key}.json`);
      if (existsSync(path)) result[i] = JSON.parse(readFileSync(path, "utf8"));
      else missing.push({ i, text, path });
    }
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const response = await budget.request(
        "embeddings",
        {
          model: "text-embedding-3-small",
          input: batch.map((x) => x.text),
          encoding_format: "float",
        },
        { apiKey, signal },
      );
      usage.push(response.metrics);
      if (response.data.data?.length !== batch.length)
        throw new Error("invalid_embeddings");
      for (const [n, item] of batch.entries()) {
        const vector = response.data.data.find((x) => x.index === n)?.embedding;
        if (
          !Array.isArray(vector) ||
          vector.length !== 1536 ||
          vector.some((x) => !Number.isFinite(x))
        )
          throw new Error("invalid_embeddings");
        result[item.i] = vector;
        writeFileSync(item.path, JSON.stringify(vector), { mode: 0o600 });
      }
    }
    return result;
  }
  return { infer, embed, usage, model };
}
