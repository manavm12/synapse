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
  reasoningEffort = "medium",
}) {
  if (!["low", "medium"].includes(reasoningEffort))
    throw new Error("invalid_reasoning_effort");
  const usage = [];
  async function infer(input, { signal } = {}) {
    const schema = JSON.parse(JSON.stringify(actionSchema));
    const knownIds = input.data.knownIds ?? [];
    const navigation = input.data.navigationIds ?? [];
    const action = (op, ids) =>
      object({
        op: { type: "string", enum: [op] },
        query: ids
          ? { type: "string", enum: [""] }
          : {
              type: "string",
              minLength: 1,
              maxLength: 450,
              description:
                "A short subject-focused query, without topic IDs or site: syntax.",
            },
        id: { type: "string", enum: ids ?? [""] },
      });
    const alternatives = [
      action("search"),
      action("sources"),
      action("topics", [
        "",
        "root",
        ...navigation.filter((id) => id.startsWith("topic:")),
      ]),
    ];
    const readable = [
      ...knownIds,
      ...navigation.filter((id) => id.startsWith("item:")),
    ];
    if (readable.length) alternatives.push(action("read", readable));
    const claims = knownIds.filter((id) => id.startsWith("claim:"));
    if (claims.length) alternatives.push(action("relations", claims));
    schema.properties.actions = {
      type: "array",
      maxItems: 12,
      items: { anyOf: alternatives },
    };
    schema.properties.selected = {
      type: "array",
      maxItems: knownIds.length ? 30 : 0,
      items: { type: "string", enum: knownIds.length ? knownIds : [""] },
      description:
        "Exact IDs observed in evidence results. Empty until evidence has been read.",
    };
    schema.properties.gaps.items = {
      type: "string",
      enum: ["missing_evidence", "unsupported_scope", "ambiguous_scope"],
    };
    // Per-request handles reduce copying cost without granting access to any new ID.
    const targets = [...new Set([...knownIds, ...navigation])];
    const encode = new Map(targets.map((id, i) => [id, `m${i + 1}`]));
    const decode = new Map([...encode].map(([id, handle]) => [handle, id]));
    const wire = (value) =>
      JSON.parse(
        JSON.stringify(value, (_key, item) =>
          typeof item === "string" ? (encode.get(item) ?? item) : item,
        ),
      );
    const wireSchema = object({
      step: {
        anyOf: [
          object({
            kind: { type: "string", enum: ["finish"] },
            selected: schema.properties.selected,
            gaps: schema.properties.gaps,
          }),
          object({
            kind: { type: "string", enum: ["retrieve"] },
            actions: { ...schema.properties.actions, minItems: 1 },
            selected: schema.properties.selected,
            gaps: schema.properties.gaps,
          }),
        ],
      },
    });
    const result = await budget.request(
      "responses",
      {
        model,
        store: false,
        service_tier: "default",
        reasoning: { effort: reasoningEffort },
        max_output_tokens: 4096,
        truncation: "disabled",
        input: [
          { role: "developer", content: input.instructions },
          { role: "user", content: JSON.stringify(wire(input.data)) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "retrieval_actions",
            strict: true,
            schema: wire(wireSchema),
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
    const reply = JSON.parse(text, (_key, item) =>
      typeof item === "string" ? (decode.get(item) ?? item) : item,
    ).step;
    if (!reply || !["finish", "retrieve"].includes(reply.kind))
      throw new Error("invalid_model_actions");
    return {
      selected: reply.selected,
      gaps: reply.gaps,
      done: reply.kind === "finish",
      actions: reply.kind === "finish" ? [] : reply.actions,
    };
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
  return { infer, embed, usage, model, reasoningEffort };
}
