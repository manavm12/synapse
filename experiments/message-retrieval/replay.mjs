import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_VERSION, createMessageContextPreparer } from "./agent.mjs";
import { buildCorpus, hash, identity } from "./corpus.mjs";
import { mockDelivery } from "./evaluate.mjs";
import { renderMessagePrompt } from "./prompt.mjs";
import {
  buildSemanticIndex,
  createRepository,
  createView,
} from "./retrieval.mjs";

// Replay saved model decisions and cached embeddings. This command never makes
// an API request and does not represent another independent quality trial.
const name = process.argv[2];
if (!/^[\w-]{1,120}$/.test(name ?? ""))
  throw new Error(
    "Usage: node experiments/message-retrieval/replay.mjs RUN_NAME",
  );
const state = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../state/message-retrieval",
);
const directory = join(state, "runs", name);
const summary = JSON.parse(
  readFileSync(join(directory, "summary.json"), "utf8"),
);
if (summary.configVersion !== CONFIG_VERSION)
  throw new Error("Replay requires the same retrieval configuration version");
const corpus = buildCorpus();
if (summary.corpus !== corpus.fingerprint)
  throw new Error("Replay corpus changed");
const repository = createRepository(corpus);
const embed = async (texts) =>
  texts.map((text) =>
    JSON.parse(
      readFileSync(
        join(
          state,
          "embeddings",
          `${hash({ model: "text-embedding-3-small", text })}.json`,
        ),
        "utf8",
      ),
    ),
  );
const semanticIndex =
  summary.strategy === "hybrid"
    ? await buildSemanticIndex(createView(repository, identity), { embed })
    : undefined;
const mismatches = [];
let cases = 0;
for (const file of readdirSync(directory).filter((n) =>
  /^(dev|heldout)-.*\.json$/.test(n),
)) {
  const saved = JSON.parse(readFileSync(join(directory, file), "utf8"));
  const steps = saved.bundle.trace.filter((s) => s.call);
  let cursor = 0;
  const next = (field) => {
    const step = steps[cursor++];
    if (!step?.[field])
      throw new Error(saved.bundle.gaps.at(-1) ?? "replay_exhausted");
    return structuredClone(step[field]);
  };
  const provider = {
    model: summary.model,
    reasoningEffort: summary.reasoningEffort,
    usage: [],
    embed,
    plan: async () => next("plan"),
    infer: async () => next("reply"),
  };
  const prepare = createMessageContextPreparer({
    repository,
    provider,
    semanticIndex,
    strategy: summary.strategy,
  });
  const bundle = await prepare(
    identity,
    saved.example.message,
    saved.example.conversationContext,
  );
  const rendered = renderMessagePrompt(mockDelivery(saved.example), bundle);
  cases++;
  if (rendered.prompt !== saved.rendered.prompt)
    mismatches.push(saved.example.id);
}
console.log(
  JSON.stringify({
    run: name,
    cases,
    identical: cases - mismatches.length,
    mismatches,
    apiCalls: 0,
  }),
);
if (mismatches.length) process.exitCode = 1;
