import { recordRuntime } from "../lib/conversation-store.mjs";
import { readHookInput, sessionRegistration } from "../lib/hook-context.mjs";
import { withInbox } from "../lib/inbox.mjs";
import { listReceiverConnections } from "../lib/receiver-registry.mjs";
import { startReceiverService } from "../lib/receiver-service.mjs";

try {
  const input = await readHookInput();
  if (
    input &&
    ["SessionStart", "UserPromptSubmit"].includes(input.hook_event_name) &&
    process.env.SYNAPSE_DISABLE_RECEIVER_SERVICE !== "1"
  ) {
    const session = sessionRegistration(input);
    const connections = listReceiverConnections({ activeOnly: true }).filter(
      (connection) => Date.parse(connection.identity.expiresAt) > Date.now(),
    );
    for (const connection of connections)
      withInbox((database) =>
        recordRuntime(database, {
          ...session,
          projectRoot: connection.projectRoot,
        }),
      );
    if (connections.length) await startReceiverService({ automatic: true });
  }
} catch {
  process.stderr.write(
    "Synapse background receiver could not start; inspect receiver status.\n",
  );
}
