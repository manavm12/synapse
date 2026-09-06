import { getPendingMemoryPrompt } from "../server/memory-store.mjs";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  if (!input.session_id || !input.cwd) {
    process.exit(0);
  }
  const result = getPendingMemoryPrompt({
    sessionId: input.session_id,
    cwd: input.cwd,
  });
  if (result.due) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: result.prompt,
        },
      }),
    );
  }
} catch {
  // Memory capture is best-effort. Hook failures must not block the user's prompt.
}
