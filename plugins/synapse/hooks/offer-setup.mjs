import { fileURLToPath } from "node:url";
import { isDeliveryPrompt } from "../lib/dispatch.mjs";
import { readInput, safeSessionId } from "../lib/hook-input.mjs";
import { offerSetupOnce } from "../lib/onboarding-state.mjs";

try {
  const input = await readInput();
  if (
    ["darwin", "win32", "linux"].includes(process.platform) &&
    process.env.CODEX_APP_TOOLS_PIPE_PATH &&
    input.hook_event_name === "UserPromptSubmit" &&
    safeSessionId(input.session_id) &&
    !isDeliveryPrompt(input.prompt) &&
    offerSetupOnce()
  ) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `Synapse first-use setup offer (once on this computer): briefly offer Enable or Later for incoming tasks. Explain that any local Codex chat can check the inbox in the background, and incoming tasks go to one saved local Git project selected during setup. Idle Codex does not poll. After acceptance, read the installed setup-synapse skill at ${fileURLToPath(new URL("../skills/setup-synapse/SKILL.md", import.meta.url))}, even if it is not in this chat's skill catalog yet. Use its bundled helper, not repository CLI instructions. Never open a browser, create credentials, or enroll without consent. Later defers automatic offers; the Synapse starter prompt Enable incoming tasks remains available. Continue the user's current request normally.`,
        },
      }),
    );
  }
} catch {
  /* Setup offers must not interrupt a user's prompt. */
}
