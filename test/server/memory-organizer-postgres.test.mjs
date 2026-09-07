import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { runMigrations } from "../../scripts/migrate.mjs";
import {
  applyMemoryChangeSet,
  currentClaims,
  deriveTopicProjection,
  emptyLedger,
  normalizeSourceEnvelope,
  prepareMemoryChangeSet,
  segmentsFor,
} from "../../src/memory/core/index.mjs";
import { createMemoryOrganizerHandler } from "../../src/server/memory-organizer/handler.mjs";
import {
  createMemoryLedgerAdapter,
  MemoryLedgerGenerationError,
} from "../../src/server/memory-organizer/storage.mjs";
import {
  createMemoryProcessingStorage,
  MemoryProcessingLeaseLostError,
} from "../../src/server/memory-processing/storage.mjs";

const adminUrl = process.env.TEST_DATABASE_URL;
const ssl = process.env.DATABASE_SSL === "disable" ? false : undefined;
const fixture = JSON.parse(
  await readFile(
    new URL("../../fixtures/memory-core/log-retention.json", import.meta.url),
    "utf8",
  ),
);
const testNow = new Date("2026-09-07T01:00:00.000Z");

test("Postgres organizer atomically preserves tenant-scoped claims, evidence and generations", {
  skip: !adminUrl,
}, async (t) => {
  // This suite creates its own database; shared TEST_DATABASE_URL data is untouched.
  const admin = new pg.Pool({ connectionString: adminUrl, ssl });
  const name = `synapse_organizer_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await admin.query(`create database "${name}" template template0`);
  const database = new pg.Pool({ connectionString: url.href, ssl });
  const workerConnections = new pg.Pool({ connectionString: url.href, ssl });
  t.after(async () => {
    await workerConnections.end();
    await database.end();
    await admin.query(`drop database "${name}" with (force)`);
    await admin.end();
  });
  await database.query(
    await readFile(new URL("../sql/bootstrap.sql", import.meta.url), "utf8"),
  );
  await runMigrations({
    connectionString: url.href,
    ssl,
    output: { write() {} },
  });
  const pool = {
    async connect() {
      const client = await workerConnections.connect();
      await client.query("set role synapse_memory_worker");
      return client;
    },
  };
  const adapter = createMemoryLedgerAdapter({ pool });
  const storage = createMemoryProcessingStorage({ pool, retryDelay: () => 0 });

  const secondIdentity = { ownerId: randomUUID(), projectId: randomUUID() };
  for (const [index, identity] of [
    fixture.identity,
    secondIdentity,
  ].entries()) {
    await database.query("insert into auth.users(id,email) values ($1,$2)", [
      identity.ownerId,
      `organizer${index}@example.test`,
    ]);
    await database.query(
      "insert into public.profiles(id,username,email,status) values ($1,$2,$3,'active')",
      [identity.ownerId, `organizer${index}`, `organizer${index}@example.test`],
    );
    await database.query(
      "insert into public.projects(id,owner_id,alias,display_name) values ($1,$2,$3,'Synthetic memory')",
      [identity.projectId, identity.ownerId, `organizer${index}`],
    );
  }
  async function seed(envelope) {
    const {
      rows: [root],
    } = await database.query(
      "select id from public.memory_nodes where project_id=$1 and kind='root'",
      [envelope.projectId],
    );
    const author = randomUUID();
    await database.query(
      `insert into public.agent_sessions(id,owner_id,project_id,client_session_id,auth_method) values($1,$2,$3,$4,'test')`,
      [author, envelope.ownerId, envelope.projectId, envelope.sessionId],
    );
    await database.query(
      `insert into public.memory_nodes(id,owner_id,project_id,parent_node_id,kind,source_session_id,title)
      values($1,$2,$3,$4,'session',$5,$6)`,
      [
        envelope.nodeId,
        envelope.ownerId,
        envelope.projectId,
        root.id,
        envelope.sessionId,
        envelope.title,
      ],
    );
    await database.query(
      `insert into public.memory_revisions(id,owner_id,project_id,node_id,author_session_id,capture_id,capture_reason,revision,title,summary,markdown,content_hash,created_at)
      values($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9,$10,$11,$12)`,
      [
        envelope.revisionId,
        envelope.ownerId,
        envelope.projectId,
        envelope.nodeId,
        author,
        envelope.captureId,
        envelope.revision,
        envelope.title,
        envelope.summary,
        envelope.markdown,
        normalizeSourceEnvelope(envelope, envelope).contentHash,
        envelope.capturedAt,
      ],
    );
    await database.query(
      `insert into synapse_private.memory_processing_jobs(owner_id,project_id,revision_id,processor_version,available_at)
      values($1,$2,$3,1,$4)`,
      [envelope.ownerId, envelope.projectId, envelope.revisionId, testNow],
    );
  }
  const first = structuredClone(fixture.steps[0].envelope);
  const second = { ...fixture.steps[1].envelope, nodeId: randomUUID() };
  await seed(first);
  await seed(second);
  const api = {
    model: "synthetic",
    reviewer: "synthetic",
    async structured(stage, prompt) {
      const data = JSON.parse(prompt.split("\n").at(-1));
      const index = data.source?.sessionId === first.sessionId ? 0 : 1;
      return {
        value:
          stage === "extract"
            ? structuredClone(fixture.steps[index].extraction)
            : stage === "reconcile"
              ? structuredClone(fixture.steps[1].reconciliation)
              : { issues: [] },
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  };
  const handler = createMemoryOrganizerHandler({
    adapter,
    api,
    now: () => testNow,
  });
  const stale = await handler.process(second);
  const result = await handler.process(first);
  const job = await storage.claimNext({
    workerId: "synthetic-worker",
    now: testNow,
    leaseDurationMs: 60_000,
  });
  assert.equal(job.source.revisionId, first.revisionId);

  await t.test(
    "durable source identity and bytes are checked before inference",
    async () => {
      for (const edit of [
        { markdown: `${first.markdown}\nchanged` },
        { summary: "changed" },
        { nodeId: second.nodeId },
        { sessionId: "wrong-session" },
        { capturedAt: "2026-08-03T10:00:00.000Z" },
      ])
        await assert.rejects(
          adapter.loadSource({ ...first, ...edit }),
          /durable revision/,
        );
      await assert.rejects(
        adapter.load({
          ownerId: secondIdentity.ownerId,
          projectId: first.projectId,
        }),
        /not available/,
      );
      await assert.rejects(
        adapter.loadSource({ ...first, ...secondIdentity }),
        /relationships/,
      );
    },
  );

  await t.test(
    "forged evidence/coverage cannot be persisted; derived writes roll back with job completion",
    async () => {
      for (const edit of [
        (copy) => {
          copy.changeSet.append.coverage = [];
        },
        (copy) => {
          copy.changeSet.append.claims[0].evidence[0].quote = "X".repeat(
            copy.changeSet.append.claims[0].evidence[0].quote.length,
          );
          copy.changeSet.projection = deriveTopicProjection({
            ...emptyLedger(fixture.identity),
            ...copy.changeSet.append,
            version: 1,
          });
        },
        (copy) => {
          copy.changeSet.source.markdown += "\nforged";
        },
      ]) {
        const forged = structuredClone(result);
        edit(forged);
        await assert.rejects(
          storage.complete(
            job,
            (client) =>
              handler.commit({ client, source: first, result: forged }),
            { now: testNow },
          ),
          /replay|source|durable/,
        );
      }
      await assert.rejects(
        storage.complete(
          job,
          async (client) => {
            await handler.commit({ client, source: first, result });
            throw new Error("Synthetic completion failure");
          },
          { now: testNow },
        ),
        /Synthetic completion failure/,
      );
      assert.equal((await adapter.load(fixture.identity)).ledger.version, 0);
      assert.equal(
        (
          await database.query(
            "select count(*) from synapse_private.memory_claims",
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await database.query(
            "select status from synapse_private.memory_processing_jobs where id=$1",
            [job.id],
          )
        ).rows[0].status,
        "processing",
      );
      assert.equal(
        (
          await database.query(
            "select markdown from public.memory_revisions where id=$1",
            [first.revisionId],
          )
        ).rows[0].markdown,
        first.markdown,
      );
    },
  );

  await t.test(
    "fenced completion is atomic and idempotent, including a lost acknowledgment",
    async () => {
      assert.equal(
        await storage.complete(
          job,
          (client) => handler.commit({ client, source: first, result }),
          { now: testNow },
        ),
        true,
      );
      assert.equal(
        await storage.complete(
          job,
          () => assert.fail("Already completed jobs cannot commit twice"),
          { now: testNow },
        ),
        false,
      );
      assert.deepEqual(
        (await adapter.load(fixture.identity)).ledger,
        applyMemoryChangeSet(emptyLedger(fixture.identity), result.changeSet),
      );
    },
  );

  const nextJob = await storage.claimNext({
    workerId: "synthetic-worker",
    now: testNow,
    leaseDurationMs: 60_000,
  });
  await t.test(
    "generation checks reject stale proposals and stale fences cannot write",
    async () => {
      await assert.rejects(
        storage.complete(
          nextJob,
          (client) => handler.commit({ client, source: second, result: stale }),
          { now: testNow },
        ),
        MemoryLedgerGenerationError,
      );
      await assert.rejects(
        storage.complete(
          { ...nextJob, leaseToken: randomUUID() },
          () => assert.fail("Fence must reject before handler"),
          { now: testNow },
        ),
        MemoryProcessingLeaseLostError,
      );
      assert.equal((await adapter.load(fixture.identity)).ledger.version, 1);
    },
  );
  const changed = await handler.process(second);
  await storage.complete(
    nextJob,
    (client) => handler.commit({ client, source: second, result: changed }),
    { now: testNow },
  );

  await t.test(
    "normalized projection and replacement history preserve original exact evidence",
    async () => {
      const { ledger, projection } = await adapter.load(fixture.identity);
      assert.equal(ledger.version, 2);
      assert.equal(ledger.claims.length, 3);
      assert.equal(currentClaims(ledger).length, 2);
      assert.deepEqual(ledger.claims[0], result.changeSet.append.claims[0]);
      assert.deepEqual(projection, changed.changeSet.projection);
      const notes = (
        await database.query(
          "select title,body,generation from synapse_private.memory_projection_notes order by ordinal",
        )
      ).rows;
      assert.deepEqual(
        notes.map((row) => row.body),
        projection.items.map((item) => item.versions[0].body),
      );
      assert.ok(notes.every((row) => row.generation === "2"));
      const evidence = (
        await database.query("select * from synapse_private.memory_evidence")
      ).rows;
      for (const entry of evidence) {
        const source = [first, second].find(
          (value) => value.revisionId === entry.revision_id,
        );
        assert.equal(
          source.markdown.slice(entry.start_offset, entry.end_offset),
          entry.quote,
        );
      }
      assert.equal(
        (
          await database.query(
            "select count(*) from synapse_private.memory_segment_coverage",
          )
        ).rows[0].count,
        "3",
      );
      await assert.rejects(
        database.query(
          "update synapse_private.memory_claims set assertion='overwrite'",
        ),
        /immutable/,
      );
      await assert.rejects(
        database.query("delete from synapse_private.memory_claim_relations"),
        /immutable/,
      );
    },
  );

  const other = {
    ...first,
    ...secondIdentity,
    revisionId: randomUUID(),
    nodeId: randomUUID(),
    captureId: randomUUID(),
    sessionId: "other-tenant",
    markdown: "# Summary\r\n😀 café keeps its exact bytes.\r\n",
  };
  await seed(other);
  const otherSegment = segmentsFor(normalizeSourceEnvelope(other, other))[0];
  const otherChange = prepareMemoryChangeSet({
    ledger: emptyLedger(secondIdentity),
    envelope: other,
    expectedIdentity: secondIdentity,
    recordedAt: testNow.toISOString(),
    extraction: {
      claims: [
        {
          ...fixture.steps[0].extraction.claims[0],
          assertion: otherSegment.text,
          evidence: [otherSegment.id],
        },
      ],
      coverage: [
        {
          segmentId: otherSegment.id,
          disposition: "claims",
          reason: "Synthetic Unicode source",
        },
      ],
    },
    reconciliation: { actions: [fixture.steps[0].reconciliation.actions[0]] },
  });
  const otherJob = await storage.claimNext({
    workerId: "synthetic-worker",
    now: testNow,
  });
  await storage.complete(
    otherJob,
    (client) =>
      handler.commit({
        client,
        source: other,
        result: { changeSet: otherChange, audit: result.audit },
      }),
    { now: testNow },
  );

  async function asRole(role, identity, operation) {
    const client = await database.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${role}`);
      await client.query(
        "select set_config('app.current_user_id',$1,true),set_config('app.current_project_id',$2,true)",
        [identity.ownerId, identity.projectId],
      );
      return await operation(client);
    } finally {
      await client.query("rollback");
      client.release();
    }
  }
  await t.test(
    "runtime/worker RLS isolate tenants and prevent capture credentials from writing derived rows",
    async () => {
      for (const role of ["synapse_runtime", "synapse_memory_worker"]) {
        await asRole(role, fixture.identity, async (client) => {
          for (const table of [
            "memory_claims",
            "memory_evidence",
            "memory_ledger_sources",
            "memory_projection_notes",
          ]) {
            const rows = (
              await client.query(
                `select distinct owner_id from synapse_private.${table}`,
              )
            ).rows;
            assert.deepEqual(rows, [{ owner_id: fixture.identity.ownerId }]);
          }
        });
      }
      await asRole(
        "synapse_memory_worker",
        {
          ownerId: fixture.identity.ownerId,
          projectId: secondIdentity.projectId,
        },
        async (client) => {
          assert.equal(
            (
              await client.query(
                "select count(*) from synapse_private.memory_claims",
              )
            ).rows[0].count,
            "0",
          );
        },
      );
      await assert.rejects(
        asRole("synapse_runtime", fixture.identity, (client) =>
          client.query("delete from synapse_private.memory_projection_notes"),
        ),
        /permission denied/,
      );
      await assert.rejects(
        asRole("authenticated", fixture.identity, (client) =>
          client.query("select * from synapse_private.memory_claims"),
        ),
        /permission denied/,
      );
      await assert.rejects(
        asRole("synapse_memory_worker", fixture.identity, (client) =>
          client.query(
            `insert into synapse_private.memory_claim_evidence(owner_id,project_id,claim_id,ordinal,segment_id)
      values($1,$2,$3,99,$4)`,
            [
              fixture.identity.ownerId,
              fixture.identity.projectId,
              result.changeSet.append.claims[0].id,
              otherSegment.id,
            ],
          ),
        ),
        /foreign key/,
      );
      assert.equal(
        (await adapter.load(secondIdentity)).ledger.claims[0].evidence[0].quote,
        otherSegment.text,
      );
    },
  );

  await t.test(
    "cross-session recaps retain prior offsets, conflicts stay disputed, and empty proposals still advance once",
    async () => {
      const recap = {
        ...first,
        revisionId: randomUUID(),
        nodeId: randomUUID(),
        captureId: randomUUID(),
        sessionId: "retention-recap",
        markdown: "# Decision\nProduction retention remains unchanged.",
        capturedAt: "2026-08-03T10:00:00.000Z",
      };
      await seed(recap);
      const previous = (await adapter.load(fixture.identity)).ledger;
      const target = currentClaims(previous).find(
        (claim) => claim.aspect === "retention",
      );
      const segment = segmentsFor(normalizeSourceEnvelope(recap, recap))[0];
      const proposal = {
        claims: [
          {
            ...fixture.steps[1].extraction.claims[0],
            evidence: [segment.id, target.evidence[0].segmentId],
          },
        ],
        coverage: [
          {
            segmentId: segment.id,
            disposition: "claims",
            reason: "No-change recap plus earlier definition",
          },
        ],
      };
      const recapChange = prepareMemoryChangeSet({
        ledger: previous,
        envelope: recap,
        expectedIdentity: fixture.identity,
        extraction: proposal,
        reconciliation: {
          actions: [
            {
              ref: "c1",
              action: "equivalent",
              targets: [target.id],
              reason: "Explicit no-change recap",
            },
          ],
        },
        recordedAt: testNow.toISOString(),
      });
      const recapJob = await storage.claimNext({
        workerId: "synthetic-worker",
        now: testNow,
      });
      await storage.complete(
        recapJob,
        (client) =>
          handler.commit({
            client,
            source: recap,
            result: { changeSet: recapChange, audit: result.audit },
          }),
        { now: testNow },
      );
      const replayed = (await adapter.load(fixture.identity)).ledger;
      assert.deepEqual(replayed.claims.at(-1).evidence[1], target.evidence[0]);
      assert.equal(currentClaims(replayed).length, 2);

      const disputed = {
        ...recap,
        revisionId: randomUUID(),
        nodeId: randomUUID(),
        captureId: randomUUID(),
        sessionId: "retention-conflict",
        markdown:
          "# Observation\nSupport reports 14-day retention; unconfirmed.",
        capturedAt: "2026-08-04T10:00:00.000Z",
      };
      await seed(disputed);
      const disputedSegment = segmentsFor(
        normalizeSourceEnvelope(disputed, disputed),
      )[0];
      const conflictChange = prepareMemoryChangeSet({
        ledger: replayed,
        envelope: disputed,
        expectedIdentity: fixture.identity,
        extraction: {
          claims: [
            {
              ...fixture.steps[1].extraction.claims[0],
              status: "disputed",
              assertion: disputedSegment.text,
              evidence: [disputedSegment.id],
            },
          ],
          coverage: [
            {
              segmentId: disputedSegment.id,
              disposition: "claims",
              reason: "Unresolved observation",
            },
          ],
        },
        reconciliation: {
          actions: [
            {
              ref: "c1",
              action: "conflicts",
              targets: [target.id],
              reason: "Conflicting unconfirmed observation",
            },
          ],
        },
        recordedAt: testNow.toISOString(),
      });
      const conflictJob = await storage.claimNext({
        workerId: "synthetic-worker",
        now: testNow,
      });
      await storage.complete(
        conflictJob,
        (client) =>
          handler.commit({
            client,
            source: disputed,
            result: { changeSet: conflictChange, audit: result.audit },
          }),
        { now: testNow },
      );
      const conflicted = (await adapter.load(fixture.identity)).ledger;
      assert.equal(currentClaims(conflicted).at(-1).state, "disputed");
      assert.equal(
        currentClaims(conflicted).find((claim) => claim.id === target.id).state,
        "active",
      );

      const empty = {
        ...recap,
        revisionId: randomUUID(),
        nodeId: randomUUID(),
        captureId: randomUUID(),
        sessionId: "no-durable-content",
        markdown: "# Empty section\n",
      };
      await seed(empty);
      const emptyChange = prepareMemoryChangeSet({
        ledger: conflicted,
        envelope: empty,
        expectedIdentity: fixture.identity,
        extraction: { claims: [], coverage: [] },
        reconciliation: { actions: [] },
        recordedAt: testNow.toISOString(),
      });
      const emptyJob = await storage.claimNext({
        workerId: "synthetic-worker",
        now: testNow,
      });
      await storage.complete(
        emptyJob,
        (client) =>
          handler.commit({
            client,
            source: empty,
            result: { changeSet: emptyChange, audit: result.audit },
          }),
        { now: testNow },
      );
      const final = (await adapter.load(fixture.identity)).ledger;
      assert.equal(final.version, 5);
      assert.equal(final.claims.length, conflicted.claims.length);
      assert.equal(final.sources.at(-1).revisionId, empty.revisionId);
      assert.equal(
        await storage.complete(
          emptyJob,
          () => assert.fail("No duplicate projection"),
          { now: testNow },
        ),
        false,
      );
    },
  );
});
