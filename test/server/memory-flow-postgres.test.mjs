import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ListToolsResultSchema } from "@modelcontextprotocol/core";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import pg from "pg";

import { runMigrations } from "../../scripts/migrate.mjs";
import { createApplication } from "../../src/server/app.mjs";
import { createDatabase } from "../../src/server/database.mjs";
import { createMemoryOrganizerHandler } from "../../src/server/memory-organizer/handler.mjs";
import { createMemoryLedgerAdapter } from "../../src/server/memory-organizer/storage.mjs";
import { createMemoryProcessingRunner } from "../../src/server/memory-processing/runner.mjs";
import { createMemoryProcessingStorage } from "../../src/server/memory-processing/storage.mjs";

const adminUrl = process.env.TEST_DATABASE_URL;
const ssl = process.env.DATABASE_SSL === "disable" ? false : undefined;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function capture(decision, overrides = {}) {
  return {
    capture_id: randomUUID(),
    session_id: "memory-flow-session",
    project_alias: "memory-flow",
    capture_reason: "turn_checkpoint",
    title: "Log retention",
    summary: "A synthetic retention decision for the composition test.",
    markdown: [
      "# Summary",
      "A synthetic memory integration test.",
      "# What changed",
      "Connected memory capture and retrieval.",
      "# Decisions",
      decision,
      "# Still unresolved",
      "None.",
      "# Important references",
      "Runbook: docs/logging.md.",
    ].join("\n\n"),
    ...overrides,
  };
}

// Only model inference and the OAuth token perimeter are fake. Every persistence,
// queue, reducer, projection, RLS, MCP dispatch and retrieval operation is real.
function deterministicInference(stages) {
  return {
    model: "deterministic-local-fixture",
    reviewer: "deterministic-local-fixture",
    async structured(stage, prompt) {
      stages.push(stage);
      const data = JSON.parse(prompt.split("\n").at(-1));
      let value;
      if (stage === "extract") {
        const segment = data.segments.find(
          (entry) => entry.section === "Decisions",
        );
        assert.ok(segment);
        value = {
          claims: [
            {
              ref: "c1",
              subject: "Log storage",
              aspect: "Retention",
              scope: segment.text.startsWith("Staging")
                ? "staging"
                : "production",
              title: "Log retention",
              assertion: segment.text,
              kind: "decision",
              status: "active",
              topic: "Operations",
              subtopic: "Logging",
              evidence: [segment.id],
            },
          ],
          coverage: data.segments.map((entry) => ({
            segmentId: entry.id,
            disposition: entry.id === segment.id ? "claims" : "context",
            reason:
              entry.id === segment.id
                ? "Supports the retention decision"
                : "Synthetic test context",
          })),
        };
      } else if (stage === "reconcile") {
        assert.equal(data.current.length, 1);
        assert.equal(data.incoming.length, 1);
        assert.match(data.incoming[0].assertion, /replacing 7 days/);
        value = {
          actions: [
            {
              ref: "c1",
              action: "replaces",
              targets: [data.current[0].id],
              reason:
                "The synthetic source explicitly changes the retention period",
            },
          ],
        };
      } else {
        assert.equal(stage, "review");
        value = { issues: [] };
      }
      return { value, usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };
}

test("Postgres memory capture composes with the queue, organizer and authenticated MCP retrieval", {
  skip: !adminUrl,
  timeout: 60_000,
}, async (t) => {
  const admin = new pg.Pool({ connectionString: adminUrl, ssl });
  const name = `synapse_memory_flow_test_${randomUUID().replaceAll("-", "")}`;
  const isolatedUrl = new URL(adminUrl);
  isolatedUrl.pathname = `/${name}`;
  let created = false;
  let fixtureDatabase;
  let workerConnections;
  let runtimeProbe;
  let database;
  let application;
  let listener;
  t.after(async () => {
    try {
      if (listener)
        await new Promise((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
      await application?.server.close();
      await database?.close();
      await workerConnections?.end();
      await runtimeProbe?.end();
      await fixtureDatabase?.end();
    } finally {
      try {
        // Pool.end() precedes socket close; do not force-kill graceful exits.
        if (created) await admin.query(`drop database "${name}"`);
      } finally {
        await admin.end();
      }
    }
  });
  // Never migrate, truncate or drop the database supplied by TEST_DATABASE_URL.
  await admin.query(`create database "${name}" template template0`);
  created = true;
  fixtureDatabase = new pg.Pool({ connectionString: isolatedUrl.href, ssl });
  await fixtureDatabase.query(
    await readFile(new URL("../sql/bootstrap.sql", import.meta.url), "utf8"),
  );
  await runMigrations({
    connectionString: isolatedUrl.href,
    ssl,
    output: { write() {} },
  });

  const runtimeUrl = new URL(isolatedUrl);
  // SET ROLE at connection startup avoids changing shared cluster role passwords.
  runtimeUrl.searchParams.set("options", "-c role=synapse_runtime");
  runtimeProbe = new pg.Pool({ connectionString: runtimeUrl.href, ssl });
  assert.equal(
    (await runtimeProbe.query("select current_user")).rows[0].current_user,
    "synapse_runtime",
  );
  database = createDatabase({ databaseUrl: runtimeUrl.href, databaseSsl: ssl });
  const owners = { alice: randomUUID(), bob: randomUUID() };
  for (const [username, ownerId] of Object.entries(owners)) {
    await fixtureDatabase.query(
      "insert into auth.users(id,email) values ($1,$2)",
      [ownerId, `${username}@memory-flow.example.test`],
    );
    await database.registerAccount(ownerId, {
      username,
      projectAlias: "memory-flow",
    });
  }
  const identities = Object.fromEntries(
    await Promise.all(
      Object.entries(owners).map(async ([name, ownerId]) => [
        name,
        await database.resolveIdentity(ownerId, {
          authMethod: "oauth",
          oauthClientId: "memory-flow-client",
        }),
      ]),
    ),
  );

  workerConnections = new pg.Pool({ connectionString: isolatedUrl.href, ssl });
  const workerPool = {
    async connect() {
      const client = await workerConnections.connect();
      try {
        await client.query("set role synapse_memory_worker");
        return client;
      } catch (error) {
        client.release();
        throw error;
      }
    },
  };
  const adapter = createMemoryLedgerAdapter({ pool: workerPool });
  const stages = [];
  const runner = createMemoryProcessingRunner({
    storage: createMemoryProcessingStorage({ pool: workerPool }),
    handler: createMemoryOrganizerHandler({
      adapter,
      api: deterministicInference(stages),
    }),
    workerId: "memory-composition-test",
    leaseDurationMs: 30_000,
  });
  const logs = [];
  const config = {
    allowedHosts: ["127.0.0.1", "localhost"],
    resourceUrl: new URL("http://127.0.0.1/mcp"),
    resourceMetadataUrl: new URL(
      "http://127.0.0.1/.well-known/oauth-protected-resource",
    ),
    supabaseIssuer: "https://example.supabase.co/auth/v1",
    supabaseUrl: new URL("https://example.supabase.co/"),
    supabaseJwksUrl: new URL(
      "https://example.supabase.co/auth/v1/.well-known/jwks.json",
    ),
    supabasePublishableKey: "sb_publishable_fixture",
    cookieSecret: "x".repeat(32),
    publicSignup: true,
    requiredScopes: ["openid", "email", "profile"],
  };
  application = await createApplication({
    config,
    database,
    memoryRetrieval: database.memoryRetrieval,
    verifier: {
      async verifyAccessToken(token) {
        if (!Object.hasOwn(identities, token))
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            "invalid fixture token",
          );
        return {
          token,
          clientId: "memory-flow-client",
          scopes: config.requiredScopes,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          resource: config.resourceUrl,
          extra: { identity: identities[token] },
        };
      },
    },
    sessionVerifier: {
      async verifyAccessToken() {
        throw new Error("No browser sessions in this fixture");
      },
    },
    logger: {
      info(event, fields) {
        logs.push({ event, ...fields });
      },
      error(event, fields) {
        logs.push({ event, ...fields });
      },
    },
    fetchImplementation: async () => {
      throw new Error("External HTTP is forbidden in this fixture");
    },
  });
  listener = application.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const endpoint = `http://127.0.0.1:${listener.address().port}/mcp`;
  let requestId = 0;
  async function rpc(token, method, params) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function call(token, name, args) {
    const response = await rpc(token, "tools/call", { name, arguments: args });
    assert.equal(response.status, 200);
    assert.equal(response.body.error, undefined);
    return response.body.result;
  }
  async function success(token, name, args) {
    const result = await call(token, name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  }

  const listed = await rpc("alice", "tools/list", {});
  assert.equal(
    ListToolsResultSchema.safeParse(listed.body.result).success,
    true,
  );
  assert.deepEqual(
    new Set(listed.body.result.tools.map((entry) => entry.name)),
    new Set([
      "get_identity",
      "save_session_memory",
      "memory_topics",
      "search_memory",
      "read_memory",
      "send_message",
      "get_message_status",
      "list_inbox",
      "begin_receiver_setup",
    ]),
  );
  assert.equal(listed.body.result.tools.length, 9);
  assert.equal((await rpc(null, "tools/list", {})).status, 401);

  const firstCapture = capture("Production retains logs for 7 days.");
  const first = await success("alice", "save_session_memory", firstCapture);
  assert.match(first.revision_id, uuid);
  assert.equal(first.revision, 1);
  assert.equal(first.idempotent, false);
  const replay = await success("alice", "save_session_memory", firstCapture);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.revision_id, first.revision_id);
  const queued = await fixtureDatabase.query(
    "select revision_id,status from synapse_private.memory_processing_jobs",
  );
  assert.deepEqual(queued.rows, [
    { revision_id: first.revision_id, status: "pending" },
  ]);
  assert.equal(
    (await success("alice", "search_memory", { query: "retention" }))
      .catalog_status,
    "empty",
  );
  const unprocessed = await success("alice", "read_memory", {
    target_type: "source",
    target_id: first.revision_id,
    max_chars: 20,
  });
  assert.equal(unprocessed.source.processed, false);
  assert.equal(unprocessed.source.text, firstCapture.markdown.slice(0, 20));
  assert.ok(unprocessed.next_cursor);
  assert.equal(
    (
      await call("bob", "read_memory", {
        target_type: "source",
        target_id: first.revision_id,
      })
    ).isError,
    true,
  );

  const bobCapture = capture("Staging retains logs for 3 days.");
  const bobSaved = await success("bob", "save_session_memory", bobCapture);
  for (let index = 0; index < 2; index++) {
    const outcome = await runner.runOnce();
    assert.equal(outcome.status, "succeeded", outcome.error?.stack);
  }
  assert.equal((await runner.runOnce()).status, "idle");
  const original = await success("alice", "search_memory", {
    query: "retention",
  });
  assert.equal(original.results.length, 1);
  assert.equal(
    original.results[0].assertion,
    "Production retains logs for 7 days.",
  );
  assert.equal(original.results[0].evidence[0].revision_id, first.revision_id);
  assert.equal(
    (
      await call("alice", "read_memory", {
        target_type: "source",
        target_id: first.revision_id,
        cursor: unprocessed.next_cursor,
      })
    ).isError,
    true,
  );

  const updatedCapture = capture(
    "Production retains logs for 30 days, replacing 7 days.",
  );
  const updated = await success("alice", "save_session_memory", updatedCapture);
  assert.equal(updated.node_id, first.node_id);
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.revision_id, first.revision_id);
  const updateOutcome = await runner.runOnce();
  assert.equal(updateOutcome.status, "succeeded", updateOutcome.error?.stack);
  assert.equal((await runner.runOnce()).status, "idle");
  assert.deepEqual(stages, [
    "extract",
    "review",
    "extract",
    "review",
    "extract",
    "reconcile",
    "review",
  ]);

  const current = await success("alice", "search_memory", {
    query: "retention",
    status: "current",
  });
  const history = await success("alice", "search_memory", {
    query: "retention",
    status: "historical",
    topic_id: "root",
  });
  assert.equal(current.results.length, 1);
  assert.equal(
    current.results[0].assertion,
    "Production retains logs for 30 days, replacing 7 days.",
  );
  assert.equal(current.results[0].evidence[0].revision_id, updated.revision_id);
  assert.equal(history.results.length, 1);
  assert.equal(history.results[0].status, "superseded");
  assert.equal(history.results[0].current, false);
  assert.equal(history.results[0].claim_id, original.results[0].claim_id);
  const note = await success("alice", "read_memory", {
    target_type: "note",
    target_id: current.results[0].note_id,
  });
  assert.match(note.note.body, /30 days/);
  assert.match(note.note.body, /Historical, superseded \(not current\)/);
  assert.deepEqual(
    new Set(note.evidence.map((entry) => entry.revision_id)),
    new Set([first.revision_id, updated.revision_id]),
  );
  const oldClaim = await success("alice", "read_memory", {
    target_type: "claim",
    target_id: history.results[0].claim_id,
  });
  assert.equal(oldClaim.claim.status, "superseded");
  assert.equal(oldClaim.claim.relations[0].type, "supersedes");

  const raw = await success("alice", "read_memory", {
    target_type: "source",
    target_id: first.revision_id,
    max_chars: 4000,
  });
  assert.equal(raw.source.processed, true);
  assert.equal(raw.source.text, firstCapture.markdown);
  assert.equal(
    raw.source.content_hash,
    createHash("sha256").update(firstCapture.markdown).digest("hex"),
  );
  assert.equal(raw.next_cursor, null);
  for (const result of [...current.results, ...history.results]) {
    const markdown = result.current
      ? updatedCapture.markdown
      : firstCapture.markdown;
    for (const evidence of result.evidence)
      assert.equal(
        markdown.slice(evidence.start, evidence.end),
        evidence.quote,
      );
  }

  const bobResults = await success("bob", "search_memory", {
    query: "retention",
    status: "all",
  });
  assert.equal(bobResults.results.length, 1);
  assert.equal(
    bobResults.results[0].assertion,
    "Staging retains logs for 3 days.",
  );
  assert.equal(
    bobResults.results[0].evidence[0].revision_id,
    bobSaved.revision_id,
  );
  for (const [target_type, target_id] of [
    ["source", first.revision_id],
    ["claim", history.results[0].claim_id],
    ["note", current.results[0].note_id],
  ]) {
    const denied = await call("bob", "read_memory", { target_type, target_id });
    assert.equal(denied.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /Production retains/);
  }
  assert.equal(
    (
      await call("bob", "search_memory", {
        query: "retention",
        owner_id: owners.alice,
      })
    ).isError,
    true,
  );
  const ledger = await adapter.load({
    ownerId: owners.alice,
    projectId: identities.alice.projectId,
  });
  assert.equal(ledger.ledger.version, 2);
  assert.equal(ledger.ledger.claims.length, 2);
  const finalQueue = await fixtureDatabase.query(
    "select status,count(*)::integer as count from synapse_private.memory_processing_jobs group by status",
  );
  assert.deepEqual(finalQueue.rows, [{ status: "succeeded", count: 3 }]);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /Production retains|Staging retains|Bearer alice|Bearer bob/,
  );
});
