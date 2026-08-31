import {
  blockDeadJobRecovery,
  completeDeadJobRecovery,
  releaseJob,
  reserveDeadJobRecovery,
  reserveNextJob,
} from "./store.mjs";

export async function dispatchInbox({ statePath, spawnWorker, recoverWorker }) {
  const recovery = await reserveDeadJobRecovery(statePath);
  if (recovery) {
    try {
      if (!recoverWorker) {
        throw new Error("Dead-worker recovery requires a Codex turn interrupter");
      }
      await recoverWorker(recovery);
      const recovered = await completeDeadJobRecovery(
        statePath,
        recovery.jobId,
        recovery.dispatchId,
        recovery.recoveryId,
      );
      if (!recovered) {
        throw new Error(`Lost recovery ownership for ${recovery.jobId}`);
      }
    } catch (error) {
      await blockDeadJobRecovery(
        statePath,
        recovery.jobId,
        recovery.dispatchId,
        recovery.recoveryId,
        `Could not stop the previous Codex turn safely: ${error.message}`,
      );
    }
  }

  const metadata = await reserveNextJob(statePath);
  if (!metadata) {
    return null;
  }

  try {
    await spawnWorker(metadata);
    return metadata;
  } catch (error) {
    await releaseJob(statePath, metadata.jobId, metadata.dispatchId);
    throw error;
  }
}
