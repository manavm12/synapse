import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Official standard-tier USD per million tokens, verified 2026-09-12.
export const RATES = Object.freeze({
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
});
const nanoCost = (input, output, rate) =>
  Math.ceil(input * rate.input * 1000 + output * rate.output * 1000);
export class BudgetError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function createBudget({ path, phase = "dev", fetchImpl = fetch }) {
  if (!["dev", "final"].includes(phase)) throw new BudgetError("invalid_phase");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS budget_config(id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER NOT NULL, dev INTEGER NOT NULL, final INTEGER NOT NULL);
    INSERT OR IGNORE INTO budget_config VALUES(1,5000000000,3000000000,2000000000);
    CREATE TABLE IF NOT EXISTS charges(id TEXT PRIMARY KEY, phase TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL);
  `);
  const config = db.prepare("SELECT * FROM budget_config WHERE id=1").get();
  if (config.total !== 5e9 || config.dev !== 3e9 || config.final !== 2e9) {
    db.close();
    throw new BudgetError("invalid_budget_config");
  }
  function summary() {
    const rows = db
      .prepare(
        "SELECT phase, sum(charged) amount, count(*) calls FROM charges GROUP BY phase",
      )
      .all();
    const dev = Number(rows.find((r) => r.phase === "dev")?.amount ?? 0) / 1e9;
    const final =
      Number(rows.find((r) => r.phase === "final")?.amount ?? 0) / 1e9;
    return {
      limitUsd: 5,
      devUsd: dev,
      finalUsd: final,
      spentUsd: dev + final,
      remainingUsd: 5 - dev - final,
      calls: rows.reduce((a, r) => a + r.calls, 0),
      uncertain: db
        .prepare(
          "SELECT count(*) n FROM charges WHERE status IN ('reserved','uncertain')",
        )
        .get().n,
    };
  }
  async function request(endpoint, body, { apiKey, signal } = {}) {
    const embedding = endpoint === "embeddings";
    if (!["responses", "embeddings"].includes(endpoint) || !RATES[body.model])
      throw new BudgetError("unsupported_request");
    if (embedding !== (body.model === "text-embedding-3-small"))
      throw new BudgetError("unsupported_model_endpoint");
    if (!apiKey) throw new BudgetError("missing_api_key");
    if (
      !embedding &&
      (body.store !== false ||
        body.service_tier !== "default" ||
        !Number.isSafeInteger(body.max_output_tokens) ||
        body.max_output_tokens < 1 ||
        body.max_output_tokens > 8192)
    )
      throw new BudgetError("unbounded_request");
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > 150000)
      throw new BudgetError("input_size");
    const inputBound =
      Buffer.byteLength(serialized) +
      8192 +
      256 * (Array.isArray(body.input) ? body.input.length : 1);
    const outputBound = embedding ? 0 : body.max_output_tokens;
    const reserve = nanoCost(inputBound, outputBound, RATES[body.model]);
    signal?.throwIfAborted();
    const id = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      const all = Number(
        db.prepare("SELECT COALESCE(sum(charged),0) n FROM charges").get().n,
      );
      const part = Number(
        db
          .prepare(
            "SELECT COALESCE(sum(charged),0) n FROM charges WHERE phase=?",
          )
          .get(phase).n,
      );
      if (all + reserve > config.total || part + reserve > config[phase])
        throw new BudgetError("budget_exhausted");
      db.prepare(
        "INSERT INTO charges(id,phase,model,status,reserved,charged,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        phase,
        body.model,
        "reserved",
        reserve,
        reserve,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    try {
      const response = await fetchImpl(
        `https://api.openai.com/v1/${endpoint}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: serialized,
          signal,
          redirect: "error",
        },
      );
      if (!response.ok || response.redirected) {
        let reason = "";
        try {
          const body = await response.json();
          const code = body?.error?.code;
          if (
            [
              "insufficient_quota",
              "rate_limit_exceeded",
              "invalid_json_schema",
              "invalid_api_key",
            ].includes(code)
          )
            reason = `_${code}`;
        } catch {}
        throw new BudgetError(`provider_http_${response.status}${reason}`);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 8e6) throw new BudgetError("response_size");
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      const input = embedding
        ? data.usage?.prompt_tokens
        : data.usage?.input_tokens;
      const output = embedding ? 0 : data.usage?.output_tokens;
      if (
        !Number.isSafeInteger(input) ||
        input < 0 ||
        input > inputBound ||
        !Number.isSafeInteger(output) ||
        output < 0 ||
        output > outputBound ||
        data.usage.total_tokens !== input + output ||
        (!embedding && data.service_tier !== "default")
      )
        throw new BudgetError("invalid_usage");
      const charged = nanoCost(input, output, RATES[body.model]);
      db.prepare(
        "UPDATE charges SET status='settled',charged=?,input_tokens=?,output_tokens=? WHERE id=?",
      ).run(charged, input, output, id);
      return {
        data,
        metrics: {
          model: data.model ?? body.model,
          inputTokens: input,
          outputTokens: output,
          costUsd: charged / 1e9,
        },
      };
    } catch (error) {
      db.prepare("UPDATE charges SET status='uncertain' WHERE id=?").run(id);
      throw error instanceof BudgetError
        ? error
        : new BudgetError(signal?.aborted ? "timeout" : "provider_failure");
    }
  }
  return { request, summary, close: () => db.close() };
}
