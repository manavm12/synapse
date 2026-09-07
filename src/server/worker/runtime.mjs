import { randomUUID } from "node:crypto";

import { databaseConnectionOptions } from "../../database-ssl.mjs";
import { runMemoryWorker } from "./lifecycle.mjs";

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
    const permissions = await pool.query(`
      select role.rolsuper, role.rolbypassrls,
             pg_has_role(current_user, 'synapse_memory_worker', 'member') as worker,
             pg_has_role(current_user, 'synapse_runtime', 'member') as runtime
      from pg_roles as role where role.rolname = current_user
    `);
    const role = permissions.rows[0];
    if (!role?.worker || role.runtime || role.rolsuper || role.rolbypassrls) {
      throw new Error(
        "Memory worker requires a dedicated non-superuser worker role without BYPASSRLS or runtime membership",
      );
    }
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
      storage: createStorage({ pool }),
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
