export const DISPATCHER_PROMPT = [
  "Run one automatic Synapse dispatcher cycle now.",
  "Follow plugins/synapse/skills/route-inbox/SKILL.md exactly.",
  "If the inbox is empty, take no other action.",
].join(" ");

export function isDispatcherPrompt(prompt) {
  return typeof prompt === "string" && prompt.trim() === DISPATCHER_PROMPT;
}
