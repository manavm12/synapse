import { setTimeout as sleep } from "node:timers/promises";

// Each durable request gets one attempt. A crashed/uncertain attempt expires;
// polling or process restarts cannot silently repeat paid inference.
export async function runMessageMemoryWorker({
  pool,
  prepare,
  signal,
  logger,
  pollMs = 500,
}) {
  while (!signal?.aborted) {
    try {
      const { rows } = await pool.query(
        "select synapse_private.claim_message_memory() as job",
      );
      const job = rows[0].job;
      if (!job) {
        await sleep(pollMs, undefined, { signal });
        continue;
      }
      const remaining = Date.parse(job.deadline_at) - Date.now();
      if (remaining <= 0) continue;
      const bundle = await prepare(job, {
        signal: AbortSignal.any([
          AbortSignal.timeout(remaining),
          ...(signal ? [signal] : []),
        ]),
      });
      const result = await pool.query(
        "select synapse_private.finish_message_memory($1,$2,$3::jsonb) as saved",
        [job.message_id, job.lease_token, JSON.stringify(bundle)],
      );
      logger.info("message_memory_prepared", {
        status: bundle.status,
        saved: result.rows[0].saved,
        ...bundle.metrics,
      });
    } catch {
      if (signal?.aborted) break;
      logger.error("message_memory_unavailable", {});
      await sleep(pollMs, undefined, { signal }).catch(() => {});
    }
  }
}
