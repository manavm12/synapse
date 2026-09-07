import pg from "pg";

import { createLogger } from "../logger.mjs";
import { createMemoryInferenceAPI } from "../memory-organizer/api.mjs";
import { createMemoryOrganizerHandler } from "../memory-organizer/handler.mjs";
import { createMemoryLedgerAdapter } from "../memory-organizer/storage.mjs";
import { createMemoryProcessingRunner } from "../memory-processing/runner.mjs";
import { createMemoryProcessingStorage } from "../memory-processing/storage.mjs";
import { loadWorkerConfig } from "./config.mjs";
import { createWorkerRuntime } from "./runtime.mjs";

const logger = createLogger();
const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);

let runtime;
try {
  runtime = await createWorkerRuntime(loadWorkerConfig(), {
    createPool: (options) => new pg.Pool(options),
    createAdapter: createMemoryLedgerAdapter,
    createAPI: createMemoryInferenceAPI,
    createHandler: createMemoryOrganizerHandler,
    createStorage: createMemoryProcessingStorage,
    createRunner: createMemoryProcessingRunner,
    signal: controller.signal,
    logger,
  });
  logger.info("memory_worker_started", { enabled: runtime.enabled });
  await runtime.run();
} catch {
  logger.error("memory_worker_failed", {});
  process.exitCode = 1;
} finally {
  for (const signal of ["SIGINT", "SIGTERM"])
    process.removeListener(signal, stop);
  try {
    await runtime?.close();
  } catch {
    logger.error("memory_worker_shutdown_failed", {});
    process.exitCode = 1;
  }
}
