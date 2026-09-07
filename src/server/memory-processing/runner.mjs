export function createMemoryProcessingRunner({
  storage,
  handler,
  workerId,
  processorVersion = 1,
  leaseDurationMs = 30_000,
  renewalIntervalMs = Math.floor(leaseDurationMs / 3),
  now = () => new Date(),
}) {
  if (!Number.isInteger(renewalIntervalMs) || renewalIntervalMs <= 0) {
    throw new TypeError("renewalIntervalMs must be a positive integer");
  }
  const enabled =
    handler != null &&
    typeof handler.process === "function" &&
    typeof handler.commit === "function";

  async function runOnce() {
    if (!enabled) return { status: "disabled" };
    const job = await storage.claimNext({
      workerId,
      processorVersion,
      leaseDurationMs,
      now: now(),
    });
    if (!job) return { status: "idle" };

    let renewalError;
    let renewalPromise;
    const timer = setInterval(() => {
      if (renewalPromise || renewalError) return;
      renewalPromise = storage
        .renewLease(job, { leaseDurationMs, now: now() })
        .catch((error) => {
          renewalError = error;
        })
        .finally(() => {
          renewalPromise = undefined;
        });
    }, renewalIntervalMs);
    timer.unref?.();

    try {
      const result = await handler.process(job.source);
      clearInterval(timer);
      await renewalPromise;
      if (renewalError) throw renewalError;
      await storage.complete(
        job,
        (client) => handler.commit({ client, source: job.source, result }),
        { now: now() },
      );
      return { status: "succeeded", jobId: job.id };
    } catch (error) {
      try {
        await storage.fail(job, error, { now: now() });
      } catch (failureError) {
        if (failureError.name !== "MemoryProcessingLeaseLostError") {
          throw failureError;
        }
      }
      return { status: "failed", jobId: job.id, error };
    } finally {
      clearInterval(timer);
      await renewalPromise;
    }
  }

  return { enabled, runOnce };
}
