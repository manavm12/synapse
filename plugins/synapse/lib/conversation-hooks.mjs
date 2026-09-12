import { bindChildSession } from "./child-binding.mjs";
import {
  activateResponse,
  confirmOutgoingIntent,
  finishResponses,
  pauseConversations,
  recordOutgoingIntent,
  recordSession,
  responseContext,
} from "./conversation-store.mjs";
import { sessionRegistration } from "./hook-context.mjs";
import { enqueueCloudEvent, withInbox } from "./inbox.mjs";
import { parseDeliveryMarker } from "./markers.mjs";
import { activeDestinations } from "./onboarding-state.mjs";
import { getReceiverConnection } from "./receiver-registry.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cloudResult(value) {
  if (value?.isError) return null;
  if (value?.structuredContent) return value.structuredContent;
  for (const content of value?.content ?? []) {
    if (content.type !== "text") continue;
    try {
      return JSON.parse(content.text);
    } catch {
      /* Other text is not a send receipt. */
    }
  }
  return null;
}

function validInput(input, tool) {
  return (
    input &&
    Object.keys(input).every((key) =>
      [
        "request_id",
        "message",
        "disposition",
        ...(tool === "reply_to_message"
          ? ["message_id"]
          : ["to_username", "conversation_id"]),
      ].includes(key),
    ) &&
    UUID.test(input.request_id ?? "") &&
    typeof input.message === "string" &&
    Buffer.byteLength(input.message) >= 1 &&
    Buffer.byteLength(input.message) <= 61440 &&
    ["continue", "complete", "needs_user"].includes(
      input.disposition ??
        (tool === "reply_to_message" ? "invalid" : "continue"),
    ) &&
    (tool === "reply_to_message"
      ? UUID.test(input.message_id ?? "")
      : /^@?[a-z][a-z0-9_-]{2,31}$/i.test(input.to_username?.trim() ?? "") &&
        (input.conversation_id == null || UUID.test(input.conversation_id)))
  );
}

export async function handleConversationHook(
  input,
  {
    env = process.env,
    inboxOptions,
    registryPath,
    register = sessionRegistration,
    receiver = getReceiverConnection,
    destinations = activeDestinations,
    bind = bindChildSession,
  } = {},
) {
  if (!input || env.SYNAPSE_TRUST_HOOK_SESSION_ID === "0") return null;
  const session = register(input, env);
  let connection = receiver(session.projectRoot, {
    ...(registryPath ? { path: registryPath } : {}),
  });
  if (connection?.status !== "connected") {
    const selected = destinations(registryPath ? { path: registryPath } : {});
    if (selected.length === 1) {
      connection = receiver(
        selected[0].projectRoot,
        registryPath ? { path: registryPath } : {},
      );
      session.projectRoot = selected[0].projectRoot;
    }
  }
  if (
    connection?.status !== "connected" ||
    !connection.identity ||
    Date.parse(connection.identity.expiresAt) <= Date.now()
  )
    return null;
  const identity = connection.identity;
  withInbox(
    (database) =>
      recordSession(database, { ...session, event: input.hook_event_name }),
    inboxOptions,
  );
  const event = input.hook_event_name;
  if (["SessionStart", "PreToolUse"].includes(event))
    await bind(input, { inboxOptions, waitMs: 0 });
  if (event === "Interrupt") {
    withInbox(
      (database) =>
        pauseConversations(database, {
          sessionId: input.session_id,
          reason: "user_interrupted",
        }),
      inboxOptions,
    );
    return null;
  }
  if (event === "UserPromptSubmit") {
    const marker =
      typeof input.prompt === "string" && parseDeliveryMarker(input.prompt);
    if (!marker)
      withInbox(
        (database) =>
          database
            .prepare(
              "UPDATE conversation_sessions SET auto_paused=0 WHERE session_id=?",
            )
            .run(input.session_id),
        inboxOptions,
      );
    if (marker?.version === 2) {
      const paused = withInbox((database) => {
        const job = database
          .prepare(
            `SELECT jobs.*, channels.thread_id, channels.pause_reason FROM jobs JOIN channels ON channels.id=jobs.channel_id WHERE jobs.id=?`,
          )
          .get(marker.jobId);
        if (
          job?.delivery_id === marker.deliveryId &&
          job.thread_id === input.session_id &&
          job.receiver_installation_id === identity.installationId &&
          job.recipient_user_id === identity.userId
        ) {
          if (
            ["routing", "uncertain"].includes(job.status) &&
            ["issued", "uncertain"].includes(job.native_mutation_state)
          ) {
            // The exact delivery has reached its already-bound destination.
            // This reconciles a lost queue receipt without a second submission.
            const now = Date.now();
            database
              .prepare(
                "UPDATE jobs SET status='completed', thread_id=?, observed_thread_id=?, observed_at=?, completed_at=?, lease_expires_at=NULL, updated_at=?, last_error=NULL WHERE id=?",
              )
              .run(input.session_id, input.session_id, now, now, now, job.id);
            enqueueCloudEvent(database, job, "delivered", now);
          }
          database
            .prepare(
              "UPDATE channels SET last_reconcile_error=NULL WHERE id=? AND last_reconcile_error IN ('resume_failed','resume_uncertain')",
            )
            .run(job.channel_id);
          if (job.pause_reason) {
            // This exact queued prompt has now been consumed and rejected.
            // A later explicit resume may safely submit its continuation.
            database
              .prepare(
                "UPDATE conversation_responses SET status='paused', updated_at=? WHERE message_id=? AND status IN ('queued','active','repair','resume_queued','resume_uncertain')",
              )
              .run(Date.now(), job.id);
            return true;
          }
          activateResponse(database, {
            messageId: marker.jobId,
            sessionId: input.session_id,
            turnId: input.turn_id,
          });
        }
      }, inboxOptions);
      if (paused)
        return {
          decision: "block",
          reason:
            "This Synapse conversation is paused. Resume it explicitly before processing queued messages.",
        };
    }
  }
  const tool = input.tool_name?.match(
    /^mcp__synapse[-_]memory__(send_message|reply_to_message)$/,
  )?.[1];
  if (tool && event === "PreToolUse" && validInput(input.tool_input, tool)) {
    try {
      withInbox(
        (database) =>
          recordOutgoingIntent(database, {
            identity,
            sessionId: input.session_id,
            projectRoot: session.projectRoot,
            toolName: tool,
            input: input.tool_input,
          }),
        inboxOptions,
      );
    } catch (error) {
      return {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: "deny",
          permissionDecisionReason: error.message,
        },
      };
    }
  }
  if (tool && event === "PostToolUse" && validInput(input.tool_input, tool)) {
    if (
      input.tool_response?.isError &&
      [
        "forbidden",
        "not_found",
        "invalid_request",
        "conflict",
        "rate_limited",
      ].includes(input.tool_response._meta?.synapse_error_code)
    ) {
      withInbox(
        (database) =>
          database
            .prepare(
              "UPDATE outgoing_intents SET status='rejected', error_code=?, updated_at=? WHERE installation_id=? AND user_id=? AND request_id=?",
            )
            .run(
              input.tool_response._meta.synapse_error_code,
              Date.now(),
              identity.installationId,
              identity.userId,
              input.tool_input.request_id.toLowerCase(),
            ),
        inboxOptions,
      );
      return null;
    }
    const sent = cloudResult(input.tool_response);
    if (
      sent &&
      UUID.test(sent.message_id ?? "") &&
      UUID.test(sent.conversation_id ?? "") &&
      sent.sender
    ) {
      try {
        withInbox(
          (database) =>
            confirmOutgoingIntent(database, {
              identity,
              requestId: input.tool_input.request_id,
              sent,
            }),
          inboxOptions,
        );
      } catch (error) {
        withInbox(
          (database) =>
            database
              .prepare(
                "UPDATE outgoing_intents SET status='needs_attention', error_code='send_result_conflict', updated_at=? WHERE installation_id=? AND user_id=? AND request_id=?",
              )
              .run(
                Date.now(),
                identity.installationId,
                identity.userId,
                input.tool_input.request_id.toLowerCase(),
              ),
          inboxOptions,
        );
        throw error;
      }
    }
  }
  if (event === "Stop") {
    const reason = withInbox(
      (database) =>
        finishResponses(database, {
          sessionId: input.session_id,
          turnId: input.turn_id,
          identity,
          stopHookActive: input.stop_hook_active === true,
        }),
      inboxOptions,
    );
    return reason ? { decision: "block", reason } : null;
  }
  if (["SessionStart", "UserPromptSubmit"].includes(event)) {
    const paused = withInbox(
      (database) =>
        database
          .prepare(
            `SELECT 1 FROM channels WHERE thread_id=? AND receiver_installation_id=? AND receiver_user_id=? AND pause_reason IS NOT NULL LIMIT 1`,
          )
          .get(input.session_id, identity.installationId, identity.userId),
      inboxOptions,
    );
    const context = withInbox(
      (database) => responseContext(database, input.session_id, identity),
      inboxOptions,
    );
    const pending = withInbox(
      (database) =>
        database
          .prepare(`SELECT arguments_json, tool_name FROM outgoing_intents
      WHERE session_id=? AND installation_id=? AND user_id=? AND status='pending' ORDER BY created_at LIMIT 5`)
          .all(input.session_id, identity.installationId, identity.userId),
      inboxOptions,
    );
    const recovery = pending.length
      ? `Unconfirmed Synapse sends: retry these exact calls with their existing request_id through authenticated MCP. Do not change their contents or create another request ID:\n${JSON.stringify(pending)}`
      : null;
    if (context || recovery || paused)
      return {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: [
            paused
              ? "Synapse has paused conversations in this task. Do not act on or reply to paused peer messages. Show the user the blocker; resume only on explicit human input using the conversation resume control."
              : null,
            context,
            recovery,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      };
  }
  return null;
}
