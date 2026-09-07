const ENDPOINT = "https://api.openai.com/v1/responses";
const NANO_USD = 1_000_000_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const REQUEST_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "max_output_tokens",
  "reasoning",
  "text",
  "temperature",
  "top_p",
  "truncation",
  "store",
  "stream",
  "service_tier",
]);
const INIT_FIELDS = new Set([
  "method",
  "headers",
  "body",
  "signal",
  "redirect",
]);
const HEADER_FIELDS = new Set([
  "authorization",
  "content-type",
  "accept",
  "openai-project",
  "openai-organization",
]);

class EvaluationBudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvaluationBudgetError";
    this.code = code;
  }
}

function fail(code, message) {
  return new EvaluationBudgetError(code, message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysWithin(value, allowed) {
  return object(value) && Object.keys(value).every((key) => allowed.has(key));
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function rateInNanos(value) {
  const nanos = Math.ceil(value * 1000);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isSafeInteger(nanos) ||
    nanos <= 0
  )
    throw fail(
      "configuration",
      "Explicit positive model token rates are required",
    );
  return BigInt(nanos);
}

function textInput(input) {
  if (typeof input === "string") return 0;
  if (!Array.isArray(input) || input.length === 0 || input.length > 1000)
    throw fail("request", "Only explicit text input is supported");
  let framing = 0;
  for (const message of input) {
    if (
      !keysWithin(message, new Set(["type", "role", "content"])) ||
      (message.type !== undefined && message.type !== "message") ||
      !["user", "assistant", "system", "developer"].includes(message.role)
    )
      throw fail("request", "Only explicit text messages are supported");
    framing += 256;
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content) || message.content.length === 0)
      throw fail("request", "Only text message content is supported");
    for (const part of message.content) {
      if (
        !keysWithin(part, new Set(["type", "text"])) ||
        part.type !== "input_text" ||
        typeof part.text !== "string"
      )
        throw fail(
          "request",
          "Tools, attachments and indirect input are not supported",
        );
      framing += 64;
    }
  }
  return framing;
}

function validateRequest(input, init, rates) {
  const url = input instanceof URL ? input.href : input;
  if (
    url !== ENDPOINT ||
    !keysWithin(init, INIT_FIELDS) ||
    init.method !== "POST" ||
    (init.redirect !== undefined && init.redirect !== "error")
  )
    throw fail(
      "request",
      "Only direct POST requests to the Responses endpoint are supported",
    );
  if (
    typeof init.body !== "string" ||
    Buffer.byteLength(init.body, "utf8") > MAX_REQUEST_BYTES
  )
    throw fail("request", "A bounded serialized JSON request body is required");
  let body;
  let headers;
  try {
    body = JSON.parse(init.body);
    headers = new Headers(init.headers);
  } catch {
    throw fail("request", "Invalid JSON request or headers");
  }
  if (
    !keysWithin(body, REQUEST_FIELDS) ||
    typeof body.model !== "string" ||
    !rates.has(body.model)
  )
    throw fail("request", "Request fields or model rates are not supported");
  if (
    body.service_tier !== "default" ||
    (body.stream !== undefined && body.stream !== false) ||
    (body.store !== undefined && body.store !== false) ||
    !Number.isSafeInteger(body.max_output_tokens) ||
    body.max_output_tokens <= 0 ||
    (body.instructions !== undefined && typeof body.instructions !== "string")
  )
    throw fail(
      "request",
      "Default service tier, text input and a positive output cap are required",
    );
  if (
    body.reasoning !== undefined &&
    !keysWithin(body.reasoning, new Set(["effort", "summary"]))
  )
    throw fail("request", "Unsupported reasoning configuration");
  if (
    body.text !== undefined &&
    (!keysWithin(body.text, new Set(["format", "verbosity"])) ||
      (body.text.format !== undefined &&
        (!keysWithin(
          body.text.format,
          new Set(["type", "name", "schema", "strict", "description"]),
        ) ||
          !["text", "json_object", "json_schema"].includes(
            body.text.format.type,
          ))))
  )
    throw fail("request", "Unsupported text output configuration");
  if (
    [...headers.keys()].some((key) => !HEADER_FIELDS.has(key)) ||
    !/^application\/json(?:\s*;|$)/i.test(headers.get("content-type") ?? "")
  )
    throw fail("request", "Only standard JSON request headers are supported");
  if (init.signal !== undefined && !(init.signal instanceof AbortSignal))
    throw fail("request", "Invalid cancellation signal");
  const framing = textInput(body.input);
  // Store/stream defaults are made explicit so the request is self-contained.
  body.store = false;
  body.stream = false;
  const serialized = JSON.stringify(body);
  return {
    serialized,
    headers,
    rate: rates.get(body.model),
    inputBound: Buffer.byteLength(serialized, "utf8") + 8192 + framing,
    outputBound: body.max_output_tokens,
  };
}

function cost(input, output, rate) {
  return BigInt(input) * rate.input + BigInt(output) * rate.output;
}

/**
 * A single in-memory guard must be shared by EVERY request in an evaluation run.
 * This is not an account limit or a cross-process/persistent spending ledger.
 * The injected transport must perform at most one HTTP request, without retries.
 * The reservation assumes text token counts are bounded by serialized UTF-8
 * bytes plus 8192 framing tokens, 256/message and 64/content part, and that the
 * provider honors max_output_tokens and standard tier pricing. Rates must be
 * verified externally, including any context-length pricing premiums. Those
 * provider assumptions are not an unconditional billing guarantee.
 * Rates and charges round UP to nanodollars; the budget rounds DOWN. All output
 * tokens are charged, including reasoning. No cached-input discount is assumed.
 * The guard never logs or retains credentials, request/response content or raw
 * transport errors in its summary. Failed/uncertain requests retain reservations.
 */
export function createEvaluationBudget({
  budgetUsd = 0,
  modelRates,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
} = {}) {
  if (
    typeof budgetUsd !== "number" ||
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    budgetUsd > 5 ||
    Math.floor(budgetUsd * NANO_USD) < 1 ||
    !object(modelRates) ||
    Object.keys(modelRates).length === 0 ||
    typeof fetchImpl !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  )
    throw fail(
      "configuration",
      "An explicit budget greater than zero and at most USD 5, rates and timeout are required",
    );
  const rates = new Map(
    Object.entries(modelRates).map(([model, value]) => {
      if (!object(value))
        throw fail("configuration", "Explicit model rates are required");
      return [
        model,
        {
          input: rateInNanos(value.inputUsdPerMillion),
          output: rateInNanos(value.outputUsdPerMillion),
        },
      ];
    }),
  );
  const budget = BigInt(Math.floor(budgetUsd * NANO_USD));
  let spent = 0n;
  let reserved = 0n;
  let halted = false;
  const counts = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    inFlight: 0,
  };

  async function budgetedFetch(input, init = {}) {
    let request;
    let reservation;
    try {
      if (halted)
        throw fail(
          "halted",
          "Evaluation halted after a provider accounting mismatch",
        );
      request = validateRequest(input, init, rates);
      if (init.signal?.aborted)
        throw fail(
          "cancelled",
          "Evaluation request was cancelled before dispatch",
        );
      reservation = cost(request.inputBound, request.outputBound, request.rate);
      if (spent + reserved + reservation > budget)
        throw fail(
          "budget",
          "Evaluation request exceeds the remaining reserved budget",
        );
    } catch (error) {
      counts.rejected++;
      throw error;
    }
    // No await before this reservation: concurrent calls cannot spend its funds.
    reserved += reservation;
    counts.attempted++;
    counts.inFlight++;
    let charge = reservation;
    const controller = new AbortController();
    let timer;
    let cancel;
    try {
      const interrupted = new Promise((_, reject) => {
        cancel = () => {
          controller.abort();
          reject(
            fail(
              "cancelled",
              "Evaluation request was cancelled; its reservation is retained",
            ),
          );
        };
        init.signal?.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(
            fail(
              "timeout",
              "Evaluation request timed out; its reservation is retained",
            ),
          );
        }, timeoutMs);
      });
      const operation = async () => {
        const response = await fetchImpl(ENDPOINT, {
          method: "POST",
          headers: request.headers,
          body: request.serialized,
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected)
          throw fail(
            "http",
            "Evaluation request failed; its reservation is retained",
          );
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          )
        )
          throw fail(
            "response",
            "Evaluation response is not JSON; its reservation is retained",
          );
        return { response, data: await response.clone().json() };
      };
      const { response, data } = await Promise.race([operation(), interrupted]);
      const usage = data?.usage;
      if (data?.service_tier !== "default") {
        halted = true;
        throw fail(
          "accounting",
          "Evaluation service tier is unverified; its reservation is retained",
        );
      }
      if (
        !["completed", "incomplete"].includes(data.status) ||
        !object(usage) ||
        !tokenCount(usage.input_tokens) ||
        !tokenCount(usage.output_tokens) ||
        !tokenCount(usage.total_tokens) ||
        usage.total_tokens !== usage.input_tokens + usage.output_tokens ||
        (usage.input_tokens_details !== undefined &&
          (!object(usage.input_tokens_details) ||
            !tokenCount(usage.input_tokens_details.cached_tokens) ||
            usage.input_tokens_details.cached_tokens > usage.input_tokens)) ||
        (usage.output_tokens_details !== undefined &&
          (!object(usage.output_tokens_details) ||
            !tokenCount(usage.output_tokens_details.reasoning_tokens) ||
            usage.output_tokens_details.reasoning_tokens > usage.output_tokens))
      )
        throw fail(
          "usage",
          "Evaluation usage is missing or invalid; its reservation is retained",
        );
      if (
        usage.input_tokens > request.inputBound ||
        usage.output_tokens > request.outputBound
      ) {
        halted = true;
        throw fail(
          "accounting",
          "Evaluation usage exceeded its token bounds; further requests are blocked",
        );
      }
      charge = cost(usage.input_tokens, usage.output_tokens, request.rate);
      counts.succeeded++;
      return response;
    } catch (error) {
      counts.failed++;
      if (error instanceof EvaluationBudgetError) throw error;
      // Neither the provider response nor a transport error may escape via logs.
      throw fail(
        "transport",
        "Evaluation request failed; its reservation is retained",
      );
    } finally {
      clearTimeout(timer);
      if (cancel) init.signal?.removeEventListener("abort", cancel);
      reserved -= reservation;
      spent += charge;
      counts.inFlight--;
    }
  }

  return Object.freeze({
    fetch: budgetedFetch,
    summary: () => ({
      budgetUsd: Number(budget) / NANO_USD,
      spentUsd: Number(spent) / NANO_USD,
      reservedUsd: Number(reserved) / NANO_USD,
      remainingUsd: Number(budget - spent - reserved) / NANO_USD,
      halted,
      calls: { ...counts },
    }),
  });
}
