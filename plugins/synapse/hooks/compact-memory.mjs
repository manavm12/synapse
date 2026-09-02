import { markCompactionDue } from "../server/memory-store.mjs";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  if (input.source !== "compact" || !input.session_id || !input.cwd) {
    process.exit(0);
  }
  const result = markCompactionDue({
    sessionId: input.session_id,
    cwd: input.cwd,
  });
  if (result.registered) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: result.prompt,
        },
      }),
    );
  }
} catch {
  // Memory capture is best-effort. Hook failures must not prevent the session.
}
