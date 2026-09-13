import pg from "pg";
import { databaseConnectionOptions } from "../../database-ssl.mjs";
import { createLogger } from "../logger.mjs";
import { createMemoryInferenceAPI } from "../memory-organizer/api.mjs";
import { createMemoryLedgerAdapter } from "../memory-organizer/storage.mjs";
import {
  createMemoryRetrievalService,
  createMemorySourceReader,
} from "../memory-retrieval/index.mjs";
import { loadWorkerDatabaseConfig } from "../worker/config.mjs";
import { requireWorkerRole } from "../worker/diagnostics.mjs";
import { createMessageMemoryAgent } from "./agent.mjs";
import { runMessageMemoryWorker } from "./worker.mjs";

const controller = new AbortController();
const stop = () => controller.abort();
const logger = createLogger();
let pool;
try {
  if (process.env.MESSAGE_MEMORY_ENABLED !== "true") {
    logger.info("message_memory_disabled", {});
  } else {
    const config = loadWorkerDatabaseConfig();
    const api = createMemoryInferenceAPI({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.MESSAGE_MEMORY_MODEL || "gpt-5-mini",
      timeoutMs: 25_000,
      maxOutputTokens: 2048,
      reasoningEffort: "low",
    });
    pool = new pg.Pool(
      databaseConnectionOptions({
        connectionString: config.databaseUrl,
        ssl: config.databaseSsl,
        max: 3,
        connectionTimeoutMillis: 3000,
        statement_timeout: 3000,
      }),
    );
    await requireWorkerRole(pool);
    const retrieval = createMemoryRetrievalService({
      adapter: createMemoryLedgerAdapter({ pool }),
      sourceReader: createMemorySourceReader({ pool }),
    });
    const prepare = createMessageMemoryAgent({
      retrieval,
      api,
      timeoutMs: 28_000,
    });
    for (const name of ["SIGINT", "SIGTERM"]) process.once(name, stop);
    await runMessageMemoryWorker({
      pool,
      prepare,
      signal: controller.signal,
      logger,
    });
  }
} catch {
  logger.error("message_memory_worker_failed", {});
  process.exitCode = 1;
} finally {
  for (const name of ["SIGINT", "SIGTERM"]) process.removeListener(name, stop);
  await pool?.end();
}
