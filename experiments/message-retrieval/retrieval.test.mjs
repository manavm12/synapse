import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDeliveryMarker } from "../../plugins/synapse/lib/markers.mjs";
import { routeDelivery } from "../../plugins/synapse/lib/native-router.mjs";
import { currentClaims } from "../../src/memory/core/index.mjs";
import { createMessageContextPreparer } from "./agent.mjs";
import { createBudget } from "./budget.mjs";
import {
  buildBenchmark,
  buildCorpus,
  hash,
  identity,
  persistCorpus,
} from "./corpus.mjs";
import { mockDelivery, scoreResult, summarize } from "./evaluate.mjs";
import { createDeliverySession, renderMessagePrompt } from "./prompt.mjs";
import { createProvider } from "./provider.mjs";
import {
  createHybridSearch,
  createRepository,
  createView,
  reciprocalRankFusion,
} from "./retrieval.mjs";

const corpus = buildCorpus(),
  project = corpus.projects[0],
  benchmark = buildBenchmark(project),
  example = benchmark.messages[0];
const repository = createRepository(corpus);
const provider = (infer) => ({ model: "fixture-model", usage: [], infer });
const finish = (selected) => ({ selected, actions: [], done: true, gaps: [] });
const prepare = (infer, options = {}) =>
  createMessageContextPreparer({
    repository,
    provider: provider(infer),
    ...options,
  });
const context = () =>
  prepare(async () =>
    finish([project.keys["logs.current"], project.keys["logs.constraint"]]),
  )(identity, example.message);

test("synthetic corpus is reproducible, scoped, and has disjoint scenario families", () => {
  assert.equal(corpus.fingerprint, buildCorpus().fingerprint);
  assert.equal(project.sources.length, 31);
  assert.equal(project.ledger.claims.length, 204);
  assert.equal(
    project.projection.topics.filter((t) => t.parentId === "root").length,
    8,
  );
  assert.equal(benchmark.messages.length, 80);
  const dev = new Set(
    benchmark.messages.filter((m) => m.split === "dev").map((m) => m.family),
  );
  assert.ok(
    benchmark.messages
      .filter((m) => m.split === "heldout")
      .every((m) => !dev.has(m.family)),
  );
  assert.ok(
    benchmark.gold.every((g) =>
      g.requirements.every((r) => r.anyOf.every(Boolean)),
    ),
  );
  assert.ok(
    currentClaims(project.ledger, { includeHistory: true }).some(
      (c) => c.state === "superseded",
    ),
  );
});
test("file repository round-trip and wrong recipient are enforced", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrieval-fixture-"));
  try {
    persistCorpus(dir, corpus, benchmark);
    assert.equal(
      createRepository(join(dir, "graph.json")).load(identity).ledger.version,
      31,
    );
    assert.throws(
      () =>
        repository.load({ userId: "foreign", projectId: identity.projectId }),
      /unavailable/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("recipient identity cannot be selected by peer content", async () => {
  await assert.rejects(
    prepare(async () => finish([]))(
      { ...identity, userId: corpus.projects[1].identity.userId },
      example.message,
    ),
    /recipient_mismatch/,
  );
  const result = await prepare(async () =>
    finish([corpus.projects[1].keys["logs.current"]]),
  )(identity, example.message);
  assert.equal(result.status, "unavailable");
  assert.equal(result.evidenceItems.length, 0);
});
test("selected claims carry exact evidence, explicit conflicts, and truthful status", async () => {
  const result = await context();
  assert.equal(result.status, "ready");
  assert.ok(
    result.evidenceItems.some((i) => i.id === project.keys["logs.conflict"]),
  );
  const rendered = renderMessagePrompt(mockDelivery(example), result);
  const score = scoreResult(example, benchmark.gold[0], rendered, project);
  assert.equal(score.recall, 1);
  assert.equal(score.invalidCitations, 0);
  assert.equal(score.wrongStatus, 0);
  assert.equal(score.foreignEvidence, 0);
});
test("source fallback recovers an omitted detail without inventing a claim", async () => {
  let calls = 0;
  const result = await prepare(async () =>
    ++calls === 1
      ? {
          ...finish([]),
          done: false,
          actions: [
            { op: "sources", query: "Invitation support Lantern", id: "" },
          ],
        }
      : finish([project.keys["invites.detail"]]),
  )(identity, example.message);
  assert.equal(result.status, "ready");
  assert.equal(result.evidenceItems[0].type, "source");
  assert.equal(result.evidenceItems[0].status, "source_only");
});
test("history traversal exposes the current successor and preserves historical labels", async () => {
  let calls = 0;
  const result = await prepare(async () =>
    ++calls === 1
      ? {
          ...finish([]),
          done: false,
          actions: [
            { op: "relations", query: "", id: project.keys["logs.current"] },
          ],
        }
      : finish([project.keys["logs.old"]]),
  )(identity, example.message);
  assert.equal(result.status, "ready");
  assert.ok(
    result.evidenceItems.some(
      (i) => i.id === project.keys["logs.old"] && i.status === "superseded",
    ),
  );
  assert.ok(
    result.evidenceItems.some((i) => i.id === project.keys["logs.current"]),
  );
});
test("conversation context is limited to preceding messages in the same conversation", async () => {
  let observed;
  await prepare(async (input) => {
    observed = input.data.conversation;
    return finish([]);
  })(identity, example.message, [
    { conversationId: "wrong", sequence: 1, text: "foreign" },
    {
      conversationId: example.message.conversationId,
      sequence: 4,
      text: "future",
    },
    {
      conversationId: example.message.conversationId,
      sequence: 1,
      text: "allowed",
    },
  ]);
  assert.deepEqual(observed, [{ sequence: 1, text: "allowed" }]);
});
test("deadline delivers verified partial selection, not fabricated no-match", async () => {
  let calls = 0;
  const result = await prepare(async () => {
    if (++calls === 1)
      return {
        selected: [project.keys["logs.current"]],
        actions: [],
        done: false,
        gaps: [],
      };
    return new Promise(() => {});
  })(identity, example.message, [], { timeoutMs: 50 });
  assert.equal(result.status, "partial");
  assert.ok(result.gaps.includes("retrieval_deadline"));
  assert.ok(result.evidenceItems.length > 0);
});
test("invalid actions and empty memory failures are unavailable", async () => {
  const result = await prepare(async () => ({
    selected: [],
    actions: [{ op: "write", query: "", id: "" }],
    done: false,
    gaps: [],
  }))(identity, example.message);
  assert.equal(result.status, "unavailable");
  assert.ok(result.gaps.includes("invalid_model_actions"));
  const unavailable = await prepare(async () => finish([]), {
    repository: {
      load() {
        throw new Error("db unavailable");
      },
    },
  })(identity, example.message);
  assert.equal(unavailable.status, "unavailable");
});
test("generation changes invalidate collected context", async () => {
  const mutable = structuredClone(corpus),
    repo = createRepository(mutable);
  const result = await prepare(
    async () => {
      mutable.projects[0].ledger.claims[0].title += " changed";
      return finish([project.keys["logs.current"]]);
    },
    { repository: repo },
  )(identity, example.message);
  assert.equal(result.status, "unavailable");
  assert.ok(result.gaps.includes("generation_changed"));
});
test("tampered source bytes are rejected before rendering citations", async () => {
  const copy = structuredClone(corpus);
  copy.projects[0].sources.find(
    (s) =>
      s.revisionId ===
      project.ledger.claims.find((c) => c.id === project.keys["logs.current"])
        .sourceId,
  ).markdown += " tampered";
  const result = await prepare(
    async () => finish([project.keys["logs.current"]]),
    { repository: createRepository(copy) },
  )(identity, example.message);
  assert.equal(result.status, "unavailable");
  assert.ok(result.gaps.includes("invalid_citation"));
});
test("bounds enforce calls/actions and unknown selection without paid retries", async () => {
  const result = await prepare(async () => ({ ...finish([]), done: false }))(
    identity,
    example.message,
    [],
    { maxCalls: 2 },
  );
  assert.equal(result.metrics.calls, 2);
  assert.ok(result.gaps.includes("call_limit"));
  await assert.rejects(
    prepare(async () => finish([]))(identity, example.message, [], {
      maxCalls: 7,
    }),
    /invalid_limits/,
  );
});
test("prompt budget preserves original text and terminal receipt, including multibyte text", async () => {
  const bundle = await context(),
    delivery = mockDelivery(example);
  const originalMarker = parseDeliveryMarker(delivery.nativePrompt);
  const rendered = renderMessagePrompt(delivery, bundle);
  assert.deepEqual(parseDeliveryMarker(rendered.prompt), originalMarker);
  assert.ok(rendered.prompt.includes(example.message.text));
  assert.ok(rendered.contextBytes <= 8192);
  const huge = {
    ...delivery,
    nativePrompt: `${"語".repeat(21500)}\n\n${originalMarker.marker}`,
  };
  const small = renderMessagePrompt(huge, bundle);
  assert.ok(small.promptBytes <= 65536);
  assert.ok(small.prompt.startsWith("語".repeat(21500)));
  assert.deepEqual(parseDeliveryMarker(small.prompt), originalMarker);
});
test("conflicting pairs stay together during context truncation", async () => {
  const bundle = await context();
  bundle.limits.contextBytes = 950;
  const rendered = renderMessagePrompt(mockDelivery(example), bundle);
  const ids = rendered.evidenceItems.map((i) => i.id);
  assert.equal(
    ids.includes(project.keys["logs.current"]),
    ids.includes(project.keys["logs.conflict"]),
  );
});
test("duplicate delivery freezes identical prompt; changed identities are rejected", async () => {
  const bundle = await context(),
    delivery = mockDelivery(example),
    session = createDeliverySession();
  assert.throws(
    () => session.submit(delivery, bundle, { currentFingerprint: "stale" }),
    /generation_changed/,
  );
  const first = session.submit(delivery, bundle, {
    currentFingerprint: bundle.graphFingerprint,
  });
  assert.deepEqual(
    first,
    session.submit(
      delivery,
      { ...bundle, status: "unavailable", evidenceItems: [] },
      { currentFingerprint: "later" },
    ),
  );
  assert.throws(
    () =>
      session.submit(
        { ...delivery, message: { ...delivery.message, text: "changed" } },
        bundle,
      ),
    /delivery_identity_conflict/,
  );
});
test("new and existing native task routes receive the enriched prompt through test doubles", async () => {
  const rendered = renderMessagePrompt(mockDelivery(example), await context());
  for (const existing of [false, true]) {
    const calls = [];
    const delivery = {
      nativePrompt: rendered.prompt,
      projectRoot: "/synthetic/project",
      source: "local",
      channelId: "fixture",
      jobId: "job",
      deliveryId: "delivery",
      channel: { threadId: existing ? "existing-task" : null, hostId: "local" },
    };
    await routeDelivery(delivery, {
      ownerThreadId: "owner",
      turnId: "turn",
      createClient: () => ({
        start: async () => {},
        close: async () => {},
        callTool: async (name, args) => {
          calls.push({ name, args });
          return {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify(
                  name === "list_projects"
                    ? {
                        projects: [
                          {
                            projectId: "p",
                            path: "/synthetic/project",
                            isGitRepository: false,
                          },
                        ],
                      }
                    : { threadId: "new-task", hostId: "local" },
                ),
              },
            ],
          };
        },
      }),
      acknowledge: () => ({ ok: true }),
    });
    assert.equal(
      calls.at(-1).name,
      existing ? "send_message_to_thread" : "create_thread",
    );
    assert.equal(calls.at(-1).args.prompt, rendered.prompt);
  }
});
test("hybrid fusion and index tenant/generation checks", () => {
  assert.deepEqual(
    reciprocalRankFusion([
      ["a", "b"],
      ["b", "c"],
    ]),
    ["b", "a", "c"],
  );
  assert.throws(
    () =>
      createHybridSearch(
        createView(repository, identity),
        {},
        { fingerprint: "stale", identity },
      ),
    /stale_or_foreign/,
  );
});
test("failed retrieval is not counted as a successful abstention", () => {
  const r = {
    score: {
      noAnswer: true,
      abstained: true,
      precision: 1,
      invalidCitations: 0,
      foreignEvidence: 0,
      wrongStatus: 0,
    },
    bundle: {
      completed: false,
      status: "unavailable",
      metrics: {
        elapsedMs: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        calls: 1,
      },
    },
    rendered: { contextBytes: 0 },
  };
  assert.equal(summarize([r]).abstention, 0);
});

const requestBody = {
  model: "gpt-5-nano",
  input: "test",
  store: false,
  service_tier: "default",
  max_output_tokens: 100,
};
const responseJSON = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
const success = () =>
  responseJSON({
    status: "completed",
    model: "gpt-5-nano",
    service_tier: "default",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    output: [
      { content: [{ type: "output_text", text: JSON.stringify(finish([])) }] },
    ],
  });
test("budget persists actual and uncertain reservations across clients/restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retrieval-budget-")),
    path = join(directory, "spend.sqlite");
  const first = createBudget({ path, fetchImpl: async () => success() });
  await first.request("responses", requestBody, {
    apiKey: "synthetic-test-key",
  });
  const amount = first.summary().spentUsd;
  first.close();
  const second = createBudget({
    path,
    fetchImpl: async () => new Response("", { status: 503 }),
  });
  assert.equal(second.summary().spentUsd, amount);
  await assert.rejects(
    second.request("responses", requestBody, { apiKey: "synthetic-test-key" }),
    /provider_http/,
  );
  assert.equal(second.summary().uncertain, 1);
  assert.ok(second.summary().spentUsd > amount);
  second.close();
  rmSync(directory, { recursive: true, force: true });
});
test("persistent budget prevents overspend including concurrent clients and malformed usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retrieval-budget-")),
    path = join(directory, "spend.sqlite");
  const budgets = Array.from({ length: 2 }, () =>
    createBudget({
      path,
      fetchImpl: async () =>
        responseJSON({
          service_tier: "default",
          usage: { input_tokens: 0, output_tokens: 9000, total_tokens: 9000 },
        }),
    }),
  );
  await assert.rejects(
    budgets[0].request("responses", requestBody, {
      apiKey: "synthetic-test-key",
    }),
    /invalid_usage/,
  );
  let blocked = false;
  const body = {
    ...requestBody,
    model: "gpt-5-mini",
    input: "x".repeat(120000),
    max_output_tokens: 8192,
  };
  for (let i = 0; i < 100 && !blocked; i++) {
    try {
      await budgets[i % 2].request("responses", body, {
        apiKey: "synthetic-test-key",
      });
    } catch (error) {
      blocked = error.code === "budget_exhausted";
    }
  }
  assert.ok(blocked);
  assert.ok(budgets[0].summary().devUsd <= 3);
  assert.equal(budgets[0].summary().finalUsd, 0);
  for (const b of budgets) b.close();
  rmSync(directory, { recursive: true, force: true });
});
test("provider parses structured responses and caches embeddings without persisting keys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retrieval-provider-"));
  let requests = 0;
  const budget = createBudget({
    path: join(directory, "spend.sqlite"),
    fetchImpl: async (url) => {
      requests++;
      return url.endsWith("/responses")
        ? success()
        : responseJSON({
            model: "text-embedding-3-small",
            usage: { prompt_tokens: 2, total_tokens: 2 },
            data: [{ index: 0, embedding: Array(1536).fill(0.1) }],
          });
    },
  });
  const p = createProvider({
    budget,
    apiKey: "synthetic-secret",
    embeddingDirectory: directory,
  });
  assert.deepEqual(
    await p.infer({ instructions: "test", data: {} }),
    finish([]),
  );
  const one = await p.embed(["a"]);
  assert.deepEqual(await p.embed(["a"]), one);
  assert.equal(requests, 2);
  assert.ok(
    !readFileSync(
      join(
        directory,
        `${hash({ model: "text-embedding-3-small", text: "a" })}.json`,
      ),
      "utf8",
    ).includes("synthetic-secret"),
  );
  budget.close();
  rmSync(directory, { recursive: true, force: true });
});
