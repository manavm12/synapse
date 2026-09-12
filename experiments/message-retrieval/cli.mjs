import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_VERSION, createMessageContextPreparer } from "./agent.mjs";
import { createBudget } from "./budget.mjs";
import {
  buildBenchmark,
  buildCorpus,
  hash,
  identity,
  persistCorpus,
} from "./corpus.mjs";
import {
  classifyFailure,
  mockDelivery,
  scoreResult,
  summarize,
} from "./evaluate.mjs";
import { renderMessagePrompt } from "./prompt.mjs";
import { createProvider } from "./provider.mjs";
import {
  buildSemanticIndex,
  createRepository,
  createView,
} from "./retrieval.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const state = join(root, "state/message-retrieval");
const writeJSON = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
const args = process.argv.slice(2),
  command = args.shift() ?? "help";
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const strategy = option("strategy", "agent"),
  model = option("model", "gpt-5-nano"),
  reasoningEffort = option("reasoning", "medium"),
  split = option("split", "dev");
const corpus = buildCorpus(),
  benchmark = buildBenchmark(corpus.projects[0]);
mkdirSync(state, { recursive: true });
const codeHash = () =>
  hash(
    readdirSync(dirname(fileURLToPath(import.meta.url)))
      .filter((p) => p.endsWith(".mjs") && !p.endsWith(".test.mjs"))
      .sort()
      .map((p) => [p, hash(readFileSync(new URL(p, import.meta.url), "utf8"))]),
  );
const executedCodeHash = codeHash();
if (command === "help") {
  console.log(
    "node experiments/message-retrieval/cli.mjs seed|demo|eval|freeze|report|budget\nOptions: --strategy lexical|agent|hybrid --model gpt-5-nano|gpt-5-mini --split dev|heldout --limit N --offset N --run NAME --concurrency N\nReal API calls require OPENAI_API_KEY. One cumulative $5 budget is stored under state/message-retrieval/spend.sqlite.",
  );
} else if (command === "seed") {
  const info = persistCorpus(state, corpus, benchmark);
  writeFileSync(
    join(state, "graph.md"),
    `# Synthetic recipient memory\n\n${JSON.stringify(info, null, 2)}\n\n` +
      corpus.projects[0].projection.topics
        .map((t) => `- ${t.title}: ${t.id}`)
        .join("\n") +
      "\n\n" +
      corpus.projects[0].projection.items
        .map(
          (n) => `## ${n.versions.at(-1).title}\n\n${n.versions.at(-1).body}`,
        )
        .join("\n\n"),
  );
  console.log(info);
} else if (command === "freeze") {
  const name = option("name", "finalists");
  const path = join(state, `${name}.freeze.json`);
  if (existsSync(path))
    throw new Error(
      "Freeze already exists; do not overwrite an evaluated specification",
    );
  writeJSON(path, {
    codeHash: executedCodeHash,
    corpus: corpus.fingerprint,
    benchmark: benchmark.fingerprint,
    configVersion: CONFIG_VERSION,
    createdAt: new Date().toISOString(),
  });
  console.log(path);
} else if (command === "budget") {
  const budget = createBudget({ path: join(state, "spend.sqlite") });
  console.log(budget.summary());
  budget.close();
} else if (command === "eval" || command === "demo") {
  if (!["dev", "heldout"].includes(split)) throw new Error("invalid_split");
  if (split === "heldout") {
    const freeze = JSON.parse(
      readFileSync(
        join(state, `${option("freeze", "finalists")}.freeze.json`),
        "utf8",
      ),
    );
    if (
      freeze.codeHash !== codeHash() ||
      freeze.corpus !== corpus.fingerprint ||
      freeze.benchmark !== benchmark.fingerprint
    )
      throw new Error("Frozen experiment changed");
  }
  const name = option("run", `${split}-${strategy}-${model}-${Date.now()}`);
  if (!/^[\w-]{1,120}$/.test(name)) throw new Error("invalid_run_name");
  const directory = join(state, "runs", name);
  if (existsSync(directory))
    throw new Error("Run already exists; results are immutable");
  mkdirSync(directory, { recursive: true });
  const budget = createBudget({
    path: join(state, "spend.sqlite"),
    phase: split === "heldout" ? "final" : "dev",
  });
  const startingBudget = budget.summary();
  const repository = createRepository(corpus);
  let semanticIndex;
  const providerOptions = {
    budget,
    apiKey: process.env.OPENAI_API_KEY,
    model,
    embeddingDirectory: join(state, "embeddings"),
    reasoningEffort,
  };
  try {
    if (strategy === "hybrid")
      semanticIndex = await buildSemanticIndex(
        createView(repository, identity),
        createProvider(providerOptions),
        AbortSignal.timeout(30000),
      );
    const selected = benchmark.messages
      .filter((m) => m.split === split)
      .slice(
        Number(option("offset", "0")),
        Number(option("offset", "0")) +
          Number(option("limit", command === "demo" ? "1" : "40")),
      );
    const results = [];
    let next = 0;
    const concurrency = Number(option("concurrency", "3"));
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 4
    )
      throw new Error("invalid_concurrency");
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < selected.length) {
          const example = selected[next++];
          const provider = createProvider(providerOptions);
          const prepare = createMessageContextPreparer({
            repository,
            provider,
            semanticIndex,
            strategy,
          });
          const bundle = await prepare(
            identity,
            example.message,
            example.conversationContext,
          );
          const rendered = renderMessagePrompt(mockDelivery(example), bundle);
          const score = scoreResult(
            example,
            benchmark.gold.find((g) => g.id === example.id),
            rendered,
            corpus.projects[0],
          );
          const result = { example, bundle, rendered, score };
          result.failureClasses = classifyFailure(result);
          writeJSON(join(directory, `${example.id}.json`), result);
          writeFileSync(
            join(directory, `${example.id}.prompt.md`),
            rendered.prompt,
          );
          results.push(result);
          console.log(
            JSON.stringify({
              case: example.id,
              status: bundle.status,
              recall: score.recall,
              precision: score.precision,
              calls: bundle.metrics.calls,
              gaps: bundle.gaps,
            }),
          );
          if (bundle.gaps.includes("budget_exhausted")) break;
        }
      }),
    );
    results.sort((a, b) => a.example.id.localeCompare(b.example.id));
    const summary = {
      run: name,
      strategy,
      model,
      split,
      reasoningEffort,
      configVersion: CONFIG_VERSION,
      codeHash: executedCodeHash,
      corpus: corpus.fingerprint,
      benchmark: benchmark.fingerprint,
      ...summarize(results),
      budgetStart: startingBudget,
      budgetEnd: budget.summary(),
    };
    writeJSON(join(directory, "summary.json"), summary);
    console.log(JSON.stringify(summary));
  } finally {
    budget.close();
  }
} else if (command === "report") {
  const runs = existsSync(join(state, "runs"))
    ? readdirSync(join(state, "runs")).flatMap((name) => {
        const path = join(state, "runs", name, "summary.json");
        return existsSync(path) ? [JSON.parse(readFileSync(path, "utf8"))] : [];
      })
    : [];
  const table = [
    "| Run | N | Recall | Complete | Precision | Abstention | Cost | p95 ms | Gates |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...runs.map(
      (r) =>
        `| ${r.run} | ${r.cases} | ${r.recall?.toFixed(3)} | ${r.complete?.toFixed(3)} | ${r.precision?.toFixed(3)} | ${r.abstention?.toFixed(3)} | $${r.costUsd.toFixed(4)} | ${r.p95LatencyMs} | ${r.passed ? "pass" : "not met"} |`,
    ),
  ];
  writeFileSync(
    join(state, "scorecard.md"),
    `# Message retrieval experiments\n\n${table.join("\n")}\n`,
  );
  console.log(table.join("\n"));
} else throw new Error("unknown_command");
