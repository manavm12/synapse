import { ReceiverWorker } from "../lib/receiver-worker.mjs";

const worker = new ReceiverWorker();
let stopping = false;
let wake;
let timer;
const stop = () => {
  stopping = true;
  clearTimeout(timer);
  wake?.();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  while (!stopping) {
    let delayMs = 60_000;
    try {
      ({ delayMs } = await worker.tick());
    } catch {
      process.stderr.write(
        "Synapse receiver needs attention; inspect receiver status.\n",
      );
    }
    if (!stopping)
      await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, delayMs);
      });
  }
} finally {
  worker.release();
}
