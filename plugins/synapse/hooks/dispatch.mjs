import { dispatchPrompt } from "../lib/dispatch.mjs";
import { readInput } from "../lib/hook-input.mjs";

const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM"])
  process.once(event, () => controller.abort());
try {
  await dispatchPrompt(await readInput(), { signal: controller.signal });
} catch {
  /* No inbox contents or delivery instructions enter the triggering chat. */
}
