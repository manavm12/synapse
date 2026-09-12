import { pauseConversations } from "./conversation-store.mjs";
import { withInbox } from "./inbox.mjs";
import { cloudChannelId } from "./receiver-contract.mjs";
import { getReceiverConnection } from "./receiver-registry.mjs";

export function controlConversation(
  { action, conversationId, projectRoot, taskId },
  { inboxOptions, registryPath, receiver = getReceiverConnection } = {},
) {
  if (!["pause", "resume", "repair"].includes(action))
    throw new Error("Unknown conversation action");
  const connection = receiver(
    projectRoot,
    registryPath ? { path: registryPath } : {},
  );
  if (
    connection?.status !== "connected" ||
    Date.parse(connection.identity.expiresAt) <= Date.now()
  ) {
    throw new Error("Connect the receiver for this project first");
  }
  return withInbox((database) => {
    const id = cloudChannelId(
      connection.identity.installationId,
      connection.identity.userId,
      conversationId,
    );
    const channel = database
      .prepare("SELECT * FROM channels WHERE id=? AND project_root=?")
      .get(id, projectRoot);
    if (!channel)
      throw new Error("Unknown conversation for this receiver and project");
    if (
      action !== "pause" &&
      database
        .prepare(
          "SELECT 1 FROM conversation_responses response JOIN jobs ON jobs.id=response.message_id WHERE jobs.channel_id=? AND response.status='resume_uncertain'",
        )
        .get(id)
    ) {
      throw new Error(
        "A resumed native submission has an uncertain outcome. Inspect the destination task and reconcile its delivery before retrying.",
      );
    }
    if (action === "repair") {
      const session = database
        .prepare(
          "SELECT * FROM conversation_sessions WHERE session_id=? AND project_root=?",
        )
        .get(taskId, projectRoot);
      if (!session)
        throw new Error(
          "Open the intended task in this project once before repairing its binding",
        );
      if (channel.thread_id && channel.thread_id !== taskId)
        throw new Error("A verified binding cannot be replaced by repair");
      if (
        database
          .prepare(
            "SELECT 1 FROM jobs WHERE channel_id=? AND status IN ('routing','accepted','uncertain')",
          )
          .get(id)
      ) {
        throw new Error(
          "Reconcile the pending native creation before repairing this conversation",
        );
      }
      database
        .prepare(
          "UPDATE channels SET thread_id=?, host_id='local', binding_state='ready', binding_role='repaired', last_reconcile_error=NULL WHERE id=?",
        )
        .run(taskId, id);
    }
    pauseConversations(database, {
      identity: connection.identity,
      conversationId,
      reason: action === "pause" ? "user_paused" : null,
    });
    return {
      conversation_id: conversationId,
      state: action === "pause" ? "paused" : "ready",
    };
  }, inboxOptions);
}
