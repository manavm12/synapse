import { setTimeout as delay } from "node:timers/promises";
import { workerFailureCategory, workerFailureDetails } from "./diagnostics.mjs";

async function pause(milliseconds, signal) {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (!signal.aborted || error.name !== "AbortError") throw error;
  }
}

// One in-flight job per process. Queue leases serialize concurrent processes.
// A stop drains the bounded current request and commit, then claims no new work.
export async function runMemoryWorker({
  runner,
  logger,
  signal,
  pollIntervalMs = 2_000,
  errorDelayMs = 5_000,
  wait = pause,
  maxJobs = null,
  describeIdle,
}) {
  if (
    maxJobs !== null &&
    (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 1000)
  )
    throw new TypeError("maxJobs must be an integer from 1 to 1000");
  if (!runner.enabled) return { status: "disabled" };
  let attempts = 0,
    succeeded = 0;
  const finish = (status) => ({ status, attempts, succeeded });
  while (!signal.aborted) {
    const started = performance.now();
    let result;
    try {
      result = await runner.runOnce();
    } catch (error) {
      // Never log provider response bodies, source content or credentials.
      logger.error("memory_worker_iteration_failed", {
        category: workerFailureCategory(error),
      });
      if (maxJobs !== null) return finish("failed");
      if (!signal.aborted) await wait(errorDelayMs, signal);
      continue;
    }
    if (result.status === "disabled") return { status: "disabled" };
    if (result.status === "succeeded" || result.status === "failed") {
      attempts++;
      if (result.status === "succeeded") succeeded++;
      logger.info("memory_worker_job_finished", {
        job_id: result.jobId,
        status: result.status,
        duration_ms: Math.round(performance.now() - started),
        ...(result.status === "failed"
          ? {
              category: workerFailureCategory(result.error),
              ...workerFailureDetails(result.error),
              queue_status: ["pending", "failed", "lease_lost"].includes(
                result.queueStatus,
              )
                ? result.queueStatus
                : "unknown",
            }
          : {}),
      });
    }
    if (maxJobs !== null) {
      if (result.status === "failed") return finish("failed");
      if (attempts >= maxJobs) return finish("limit_reached");
      if (result.status === "idle") return finish(await describeIdle());
    }
    if (!signal.aborted && result.status !== "succeeded") {
      await wait(
        result.status === "failed" ? errorDelayMs : pollIntervalMs,
        signal,
      );
    }
  }
  return maxJobs === null ? { status: "stopped" } : finish("stopped");
}
