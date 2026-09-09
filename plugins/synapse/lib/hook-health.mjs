import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { safeSessionId } from "./hook-input.mjs";
import { readPromptReceipt, savePromptReceipt } from "./onboarding-state.mjs";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(
  readFileSync(
    new URL("../.codex-plugin/plugin.json", import.meta.url),
    "utf8",
  ),
).version;

// Written only by the real prompt hook, never by setup's immediate inbox attempt.
// A receipt from another chat/build must not make a stale installation look ready.
export function recordPromptHook(input, options = {}) {
  if (
    input?.hook_event_name !== "UserPromptSubmit" ||
    !safeSessionId(input.session_id)
  )
    return;
  savePromptReceipt(
    { sessionId: input.session_id, pluginRoot, version },
    options,
  );
}

export function promptHookHealth(sessionId, options = {}) {
  const receipt = safeSessionId(sessionId)
    ? readPromptReceipt(sessionId, options)
    : null;
  if (!receipt) return { status: "not_observed" };
  if (receipt.plugin_root !== pluginRoot || receipt.version !== version)
    return { status: "different_build" };
  const age = (options.now ?? Date.now)() - receipt.observed_at;
  if (age < 0 || age > 30 * 60_000) return { status: "stale" };
  return { status: "verified", observed_at: receipt.observed_at };
}
