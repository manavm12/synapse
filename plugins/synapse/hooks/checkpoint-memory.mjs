import { checkpointMemory } from "../server/memory-store.mjs";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  if (!input.session_id || !input.turn_id || !input.cwd) process.exit(0);
  const result = checkpointMemory({
    sessionId: input.session_id,
    turnId: input.turn_id,
    cwd: input.cwd,
    stopHookActive: input.stop_hook_active === true,
  });
  if (result.decision === "block") {
    process.stdout.write(
      JSON.stringify({ decision: "block", reason: result.reason }),
    );
  }
} catch {
  // Checkpoint scheduling is best-effort and must never block the user's task.
}
