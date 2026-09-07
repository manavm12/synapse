import { setTimeout as delay } from "node:timers/promises";

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
}) {
  if (!runner.enabled) return { status: "disabled" };
  while (!signal.aborted) {
    let result;
    try {
      result = await runner.runOnce();
    } catch {
      // Never log provider response bodies, source content or credentials.
      logger.error("memory_worker_iteration_failed", {});
      if (!signal.aborted) await wait(errorDelayMs, signal);
      continue;
    }
    if (result.status === "disabled") return { status: "disabled" };
    if (result.status === "succeeded" || result.status === "failed") {
      logger.info("memory_worker_job_finished", {
        job_id: result.jobId,
        status: result.status,
      });
    }
    if (!signal.aborted && result.status !== "succeeded") {
      await wait(
        result.status === "failed" ? errorDelayMs : pollIntervalMs,
        signal,
      );
    }
  }
  return { status: "stopped" };
}
