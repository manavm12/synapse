import { bindChildSession } from "../lib/child-binding.mjs";
import { readHookInput } from "../lib/hook-context.mjs";

try {
  const input = await readHookInput();
  if (input?.hook_event_name === "SessionStart" && input.source === "startup")
    await bindChildSession(input);
} catch {
  // The registered session is retried by the background receiver.
}
