import { dispatchPrompt } from "../lib/dispatch.mjs";
import { readInput } from "../lib/hook-input.mjs";
import { deferSetup, setupConnections } from "../lib/onboarding-state.mjs";
import {
  completeSetup,
  disableSetup,
  prepareSetup,
  setupStatus,
} from "../lib/plugin-setup.mjs";

const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM"])
  process.once(event, () =>
    controller.abort(
      new Error("Setup interrupted; saved progress can be resumed."),
    ),
  );
try {
  const input = await readInput(process.stdin, { line: true });
  const dependencies = {
    signal: controller.signal,
    onProgress: (message) => process.stderr.write(`${message}\n`),
  };
  let result;
  switch (input.action) {
    case "inspect":
      result = { connections: setupConnections() };
      break;
    case "later":
      deferSetup();
      result = { status: "deferred" };
      break;
    case "prepare":
      result = await prepareSetup(input, dependencies);
      break;
    case "complete":
      result = await completeSetup(input, dependencies);
      break;
    case "status":
      result = await setupStatus(input, dependencies);
      break;
    case "disable":
      result = await disableSetup(input, dependencies);
      break;
    default:
      throw new Error("Unknown Synapse setup action");
  }
  if (
    ["prepare", "complete"].includes(input.action) &&
    result.enrollment_status === "connected"
  ) {
    // One bounded attempt, not a persistent runner. Inbox contents never reach stdout.
    const delivery = await dispatchPrompt(
      {
        hook_event_name: "UserPromptSubmit",
        cwd: process.cwd(),
        session_id: input.session_id ?? process.env.CODEX_THREAD_ID,
      },
      { signal: controller.signal },
    ).catch(() => ({ status: "check_failed" }));
    result.initial_check = delivery?.attempted
      ? "attempted"
      : (delivery?.status ?? "checked");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ status: "action_required", message: error.message })}\n`,
  );
  process.exitCode = 1;
}
