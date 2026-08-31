import { STATE_PATH } from "./config.mjs";
import { dispatchInbox } from "./dispatch.mjs";
import { interruptTurnForRecovery } from "./recovery.mjs";
import { spawnDetachedWorker } from "./worker-process.mjs";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

await readStdin();
const metadata = await dispatchInbox({
  statePath: STATE_PATH,
  spawnWorker: spawnDetachedWorker,
  recoverWorker: interruptTurnForRecovery,
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
