import assert from "node:assert/strict";
import test from "node:test";
import { buildCorpus, identity } from "./corpus.mjs";
import { createPlanner, executePlan, planningDirectory } from "./planner.mjs";
import { createRepository, createView } from "./retrieval.mjs";

const corpus = buildCorpus(),
  project = corpus.projects[0];
const view = createView(createRepository(corpus), identity);
const directory = planningDirectory(view);
const target = (title, aspects, extra = {}) => ({
  topicId: directory.find((t) => t.title === title).id,
  aspects,
  scope: "production",
  history: false,
  sourceQuery: "",
  ...extra,
});
const execute = (targets) =>
  executePlan(
    view,
    { disposition: "retrieve", targets },
    (query) => view.search(query, { all: true }),
    (_action, work) => work(),
  );

test("planned topic navigation preserves historical relationships without mixing staging", async () => {
  const ids = await execute([
    target("Diagnostic event retention", ["policy"], { history: true }),
  ]);
  assert.ok(ids.includes(project.keys["logs.old"]));
  assert.ok(ids.includes(project.keys["logs.current"]));
  assert.ok(ids.includes(project.keys["logs.conflict"]));
  assert.ok(!ids.includes(project.keys["logs.staging"]));
  assert.ok(!ids.includes(project.keys["logs.constraint"]));
});

test("planned source fallback recovers an unorganized detail beside a runbook", async () => {
  const ids = await execute([
    target("Invitation token lifetime", ["runbook"], {
      scope: "unspecified",
      sourceQuery: "Invitation token lifetime",
    }),
  ]);
  assert.ok(ids.includes(project.keys["invites.reference"]));
  assert.ok(ids.includes(project.keys["invites.detail"]));
  assert.ok(!ids.includes(project.keys["invites.answer"]));
});

test("plans reject unobserved topics and scopes; resolutions select accepted answers", async () => {
  await assert.rejects(
    execute([
      {
        ...target("Diagnostic event retention", ["policy"]),
        topicId: "foreign",
      },
    ]),
    /invalid_model_actions/,
  );
  await assert.rejects(
    execute([
      target("Diagnostic event retention", ["policy"], { scope: "moon" }),
    ]),
    /invalid_model_actions/,
  );
  const ids = await execute([
    target("Database snapshot retention", ["resolution"]),
  ]);
  assert.deepEqual(ids, [project.keys["snapshots.answer"]]);
});

test("planner requests contain only directory metadata and the conversation", async () => {
  let sent;
  const expected = { disposition: "missing_evidence", targets: [] };
  const usage = [];
  const plan = createPlanner({
    model: "gpt-5-nano",
    reasoningEffort: "low",
    apiKey: "synthetic",
    usage,
    budget: {
      request: async (_endpoint, body) => {
        sent = body;
        return {
          metrics: { costUsd: 0 },
          data: {
            status: "completed",
            output: [
              {
                content: [
                  { type: "output_text", text: JSON.stringify(expected) },
                ],
              },
            ],
          },
        };
      },
    },
  });
  assert.deepEqual(
    await plan({
      message: "Unknown payroll provider?",
      conversation: [],
      directory,
    }),
    expected,
  );
  assert.ok(!sent.input[1].content.includes("assertion"));
  assert.ok(!sent.input[1].content.includes("requirements"));
  assert.equal(usage.length, 1);
});
