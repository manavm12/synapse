import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { RUNTIME_ROOT, STATE_PATH, WORKER_PATH } from "./config.mjs";
import { dispatchInbox } from "./dispatch.mjs";
import { setJobWorker } from "./store.mjs";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

async function spawnDetachedWorker(metadata) {
  const logDirectory = join(RUNTIME_ROOT, "logs");
  await mkdir(logDirectory, { recursive: true });
  const logName = createHash("sha256")
    .update(`${metadata.jobId}:${metadata.dispatchId}`)
    .digest("hex");
  const output = openSync(join(logDirectory, `${logName}.log`), "a");
  const child = spawn(
    process.execPath,
    [WORKER_PATH, metadata.jobId, metadata.channelId, metadata.dispatchId],
    {
      detached: true,
      env: { ...process.env, SYNAPSE_STATE_PATH: STATE_PATH },
      stdio: ["ignore", output, output],
    },
  );
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    closeSync(output);
  }
  child.unref();
  try {
    await setJobWorker(STATE_PATH, metadata.jobId, metadata.dispatchId, child.pid);
  } catch (error) {
    process.kill(child.pid, "SIGTERM");
    throw error;
  }
}

await readStdin();
const metadata = await dispatchInbox({
  statePath: STATE_PATH,
  spawnWorker: spawnDetachedWorker,
});

if (metadata) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Synapse dispatched an incoming task in a separate child thread.",
      },
    }),
  );
}
