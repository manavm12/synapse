import { dispatchPrompt, isDeliveryPrompt } from "../lib/dispatch.mjs";
import { recordPromptHook } from "../lib/hook-health.mjs";
import { readInput } from "../lib/hook-input.mjs";

const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM"])
  process.once(event, () => controller.abort());
try {
  const input = await readInput();
  try {
    if (!isDeliveryPrompt(input.prompt)) recordPromptHook(input);
  } catch {
    /* A busy diagnostic store must not prevent the inbox check itself. */
  }
  await dispatchPrompt(input, { signal: controller.signal });
} catch {
  /* No inbox contents or delivery instructions enter the triggering chat. */
}
