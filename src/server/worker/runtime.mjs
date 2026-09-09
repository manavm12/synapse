import { randomUUID } from "node:crypto";

import { databaseConnectionOptions } from "../../database-ssl.mjs";
import { requireWorkerRole, WorkerDatabaseError } from "./diagnostics.mjs";
import { runMemoryWorker } from "./lifecycle.mjs";
import { workerScope } from "./options.mjs";
import { inspectWorkerSchema, readMemoryStatus } from "./status.mjs";

export async function createWorkerRuntime(
  config,
  {
    createPool,
    createAdapter,
    createAPI,
    createHandler,
    createStorage,
    createRunner,
    logger,
    signal,
    workerId = randomUUID(),
    scope: requestedScope = null,
    maxJobs = null,
  },
) {
  if (!config.enabled) {
    return {
      enabled: false,
      async run() {
        return { status: "disabled" };
      },
      async close() {},
    };
  }
  const scope = requestedScope === null ? null : workerScope(requestedScope);
  if (
    (scope === null) !== (maxJobs === null) ||
    (maxJobs !== null &&
      (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 1000)) ||
    (scope?.revisionId && maxJobs !== 1)
  )
    throw new TypeError(
      "A canary requires exact scope and maxJobs from 1 to 1000",
    );
  const pool = createPool(
    databaseConnectionOptions({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    }),
  );
  try {
    await requireWorkerRole(pool);
    const tables = await inspectWorkerSchema(pool);
    if (tables.some((table) => !table.present || !table.permitted))
      throw new WorkerDatabaseError("database_schema");
    if (scope && !(await readMemoryStatus({ pool, scope })).ready)
      throw new WorkerDatabaseError("database_schema");
    const adapter = createAdapter({ pool });
    const api = createAPI({
      apiKey: config.apiKey,
      model: config.model,
      reviewer: config.reviewModel,
      timeoutMs: config.requestTimeoutMs,
      maxOutputTokens: config.maxOutputTokens,
    });
    const handler = createHandler({
      adapter,
      api,
      signal,
      reviewStrategy: config.reviewStrategy,
      maxStageCalls: config.maxStageCalls,
    });
    const runner = createRunner({
      storage: createStorage({ pool, scope }),
      handler,
      workerId,
      leaseDurationMs: config.leaseDurationMs,
    });
    let closed = false;
    return {
      enabled: true,
      run: () =>
        runMemoryWorker({
          runner,
          logger,
          signal,
          pollIntervalMs: config.pollIntervalMs,
          errorDelayMs: config.errorDelayMs,
          maxJobs,
          describeIdle: async () => {
            const status = await readMemoryStatus({ pool, scope });
            if (!status.ready) throw new WorkerDatabaseError("database_schema");
            return status.work_remaining ? "blocked" : "idle";
          },
        }),
      async close() {
        if (closed) return;
        closed = true;
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
