import { handleConversationHook } from "../lib/conversation-hooks.mjs";
import { readHookInput } from "../lib/hook-context.mjs";

let input;
try {
  input = await readHookInput();
  const result = await handleConversationHook(input);
  if (result) process.stdout.write(JSON.stringify(result));
} catch {
  if (input?.hook_event_name === "PreToolUse")
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Synapse could not durably record this send. Run receiver status and retry with the same request_id.",
        },
      }),
    );
  // Never print message bodies or credentials in hook errors.
  process.stderr.write(
    "Synapse conversation tracking needs attention; run receiver status.\n",
  );
}
