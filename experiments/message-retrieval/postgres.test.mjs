import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { runMigrations } from "../../scripts/migrate.mjs";
import { createMemoryLedgerAdapter } from "../../src/server/memory-organizer/storage.mjs";
import { createMemoryProcessingStorage } from "../../src/server/memory-processing/storage.mjs";
import {
  createMemoryRetrievalService,
  createMemorySourceReader,
} from "../../src/server/memory-retrieval/index.mjs";
import { buildCorpus, hash, uuid } from "./corpus.mjs";

const url = process.env.TEST_DATABASE_URL;

test("synthetic graph round-trips through production PostgreSQL roles, fenced commits, and retrieval", {
  skip: !url,
  timeout: 120000,
}, async (t) => {
  const admin = new pg.Pool({ connectionString: url, ssl: false });
  const name = `retrieval_fixture_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(url);
  databaseUrl.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const db = new pg.Pool({ connectionString: databaseUrl.href, ssl: false });
  const workerDb = new pg.Pool({
    connectionString: databaseUrl.href,
    ssl: false,
  });
  const runtimeDb = new pg.Pool({
    connectionString: databaseUrl.href,
    ssl: false,
  });
  t.after(async () => {
    await workerDb.end();
    await runtimeDb.end();
    await db.end();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  });
  await db.query(
    await readFile(
      new URL("../../test/sql/bootstrap.sql", import.meta.url),
      "utf8",
    ),
  );
  await runMigrations({
    connectionString: databaseUrl.href,
    ssl: false,
    output: { write() {} },
  });
  const poolFor = (pool, role) => ({
    connect: async () => {
      const client = await pool.connect();
      await client.query(`SET ROLE ${role}`);
      return client;
    },
  });
  const worker = poolFor(workerDb, "synapse_memory_worker");
  const runtime = poolFor(runtimeDb, "synapse_runtime");
  const adapter = createMemoryLedgerAdapter({ pool: worker });
  const storage = createMemoryProcessingStorage({ pool: worker });
  const corpus = buildCorpus();
  const now = new Date("2026-09-12T00:00:00.000Z");
  // The database supports one project per owner. The primary and foreign-owner
  // fixtures exercise the real SQL contract; an impossible alternate-project
  // snapshot is used only to stress the file adapter's additional fencing.
  for (const [index, project] of corpus.projects.slice(0, 2).entries()) {
    const { userId, projectId } = project.identity;
    await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [
      userId,
      `retrieval${index}@example.test`,
    ]);
    await db.query(
      "INSERT INTO public.profiles(id,username,email,status) VALUES($1,$2,$3,'active')",
      [userId, `retrieval${index}`, `retrieval${index}@example.test`],
    );
    await db.query(
      "INSERT INTO public.projects(id,owner_id,alias,display_name) VALUES($1,$2,$3,'Synthetic retrieval')",
      [projectId, userId, `retrieval${index}`],
    );
    const root = (
      await db.query(
        "SELECT id FROM public.memory_nodes WHERE project_id=$1 AND kind='root'",
        [projectId],
      )
    ).rows[0];
    for (const step of project.steps) {
      const s = step.envelope,
        author = uuid(`${s.revisionId}:author`);
      await db.query(
        "INSERT INTO public.agent_sessions(id,owner_id,project_id,client_session_id,auth_method) VALUES($1,$2,$3,$4,'test')",
        [author, userId, projectId, s.sessionId],
      );
      await db.query(
        "INSERT INTO public.memory_nodes(id,owner_id,project_id,parent_node_id,kind,source_session_id,title) VALUES($1,$2,$3,$4,'session',$5,$6)",
        [s.nodeId, userId, projectId, root.id, s.sessionId, s.title],
      );
      await db.query(
        "INSERT INTO public.memory_revisions(id,owner_id,project_id,node_id,author_session_id,capture_id,capture_reason,revision,title,summary,markdown,content_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9,$10,$11,$12)",
        [
          s.revisionId,
          userId,
          projectId,
          s.nodeId,
          author,
          s.captureId,
          s.revision,
          s.title,
          s.summary,
          s.markdown,
          hash(s.markdown),
          s.capturedAt,
        ],
      );
      await db.query(
        "INSERT INTO synapse_private.memory_processing_jobs(owner_id,project_id,revision_id,processor_version,available_at) VALUES($1,$2,$3,1,$4)",
        [userId, projectId, s.revisionId, now],
      );
      const job = await storage.claimNext({
        workerId: "retrieval-fixture",
        now,
        leaseDurationMs: 60000,
      });
      assert.equal(job.revisionId, s.revisionId);
      assert.equal(
        await storage.complete(
          job,
          (client) =>
            adapter.commit({
              client,
              source: s,
              result: { changeSet: step.changeSet, audit: { synthetic: true } },
            }),
          { now },
        ),
        true,
      );
    }
    const loaded = await createMemoryLedgerAdapter({ pool: runtime }).load({
      ownerId: userId,
      projectId,
    });
    assert.deepEqual(loaded.ledger, project.ledger);
    assert.deepEqual(loaded.projection, project.projection);
  }
  const retrieval = createMemoryRetrievalService({
    adapter: createMemoryLedgerAdapter({ pool: runtime }),
    sourceReader: createMemorySourceReader({ pool: runtime }),
  });
  const primary = corpus.projects[0],
    foreign = corpus.projects[1];
  const result = await retrieval.search(primary.identity, {
    query: "Diagnostic event retention",
    limit: 10,
  });
  assert.ok(result.results.length);
  assert.ok(
    result.results.every((r) =>
      r.evidence.every((e) =>
        primary.sources.some((s) => s.revisionId === e.revision_id),
      ),
    ),
  );
  await assert.rejects(
    retrieval.read(primary.identity, {
      target_type: "source",
      target_id: foreign.sources[0].revisionId,
    }),
    /not found/,
  );
  await assert.rejects(
    retrieval.search(
      { ...primary.identity, projectId: foreign.identity.projectId },
      { query: "retention" },
    ),
    /not available/,
  );
});
