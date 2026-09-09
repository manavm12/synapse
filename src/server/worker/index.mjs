import pg from "pg";

import { createLogger } from "../logger.mjs";
import { createMemoryInferenceAPI } from "../memory-organizer/api.mjs";
import { createMemoryOrganizerHandler } from "../memory-organizer/handler.mjs";
import { createMemoryLedgerAdapter } from "../memory-organizer/storage.mjs";
import { createMemoryProcessingRunner } from "../memory-processing/runner.mjs";
import { createMemoryProcessingStorage } from "../memory-processing/storage.mjs";
import { loadWorkerConfig } from "./config.mjs";
import {
  WorkerConfigurationError,
  workerFailureCategory,
} from "./diagnostics.mjs";
import { parseWorkerArguments } from "./options.mjs";
import { createWorkerRuntime } from "./runtime.mjs";

const logger = createLogger();
const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);

let runtime;
try {
  const options = parseWorkerArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: npm run worker\n       npm run worker:canary -- --owner-id <UUID> --project-id <UUID> --max-jobs <1..1000>\nCanaries count claimed attempts, stop on failure or no eligible work, and must run without automatic restarts.\n",
    );
  } else {
    const config = loadWorkerConfig();
    if (options.maxJobs !== null && !config.enabled)
      throw new WorkerConfigurationError(
        "A canary requires MEMORY_PROCESSING_ENABLED=true",
      );
    runtime = await createWorkerRuntime(config, {
      createPool: (options) => new pg.Pool(options),
      createAdapter: createMemoryLedgerAdapter,
      createAPI: createMemoryInferenceAPI,
      createHandler: createMemoryOrganizerHandler,
      createStorage: createMemoryProcessingStorage,
      createRunner: createMemoryProcessingRunner,
      signal: controller.signal,
      logger,
      ...options,
    });
    logger.info("memory_worker_started", {
      enabled: runtime.enabled,
      mode: options.maxJobs === null ? "continuous" : "canary",
      max_jobs: options.maxJobs,
    });
    const result = await runtime.run();
    logger.info("memory_worker_stopped", result);
    if (options.maxJobs !== null && result.status !== "limit_reached")
      process.exitCode = result.status === "failed" ? 1 : 2;
  }
} catch (error) {
  logger.error("memory_worker_failed", {
    category: workerFailureCategory(error),
  });
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
