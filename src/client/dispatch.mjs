import { releaseJob, reserveNextJob } from "./store.mjs";

export async function dispatchInbox({ statePath, spawnWorker }) {
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
