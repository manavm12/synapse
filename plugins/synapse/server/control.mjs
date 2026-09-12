import { pathToFileURL } from "node:url";
import { controlConversation } from "../lib/conversation-control.mjs";
import { primaryCheckout } from "../lib/hook-context.mjs";
import {
  receiverServiceStatus,
  startReceiverService,
  stopReceiverService,
} from "../lib/receiver-service.mjs";

export async function control(arguments_) {
  const [kind, action, id, ...extra] = arguments_;
  if (
    kind === "receiver" &&
    ["start", "stop", "status"].includes(action) &&
    !id
  ) {
    if (action === "start") return startReceiverService();
    if (action === "stop") return stopReceiverService({});
    return receiverServiceStatus();
  }
  if (
    kind === "conversation" &&
    id &&
    ["pause", "resume", "repair"].includes(action)
  ) {
    if (
      action === "repair"
        ? extra.length !== 2 || extra[0] !== "--task"
        : extra.length !== 0
    )
      throw new Error("Repair requires --task <native-task-id>");
    return controlConversation({
      action,
      conversationId: id,
      taskId: extra[1],
      projectRoot: primaryCheckout(process.cwd()),
    });
  }
  throw new Error(
    "Usage: control.mjs receiver start|stop|status, or conversation pause|resume|repair <conversation-id> [--task <native-task-id>]",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await control(process.argv.slice(2)), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
