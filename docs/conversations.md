# Conversational messaging

Alice sends a request from her current task. Bob receives one child task, asks a
question, receives Alice's answer in that same child, and sends a result back to
Alice's original task. The local receiver drives delivery without another owner
prompt. Multiple conversations can share Alice's original task; delivery is
serialized by destination task as well as by conversation.

Both participants must enroll upgraded receivers and use a compatible Codex
desktop. Run `npm run synapse -- doctor .` and check `conversations_ready` in
its JSON output. An accessible existing app-server control socket with
`thread/queue/list` and `thread/queue/add` support is required. The receiver never
starts a separate app-server or uses a busy-task steering tool as a fallback.
If necessary, `SYNAPSE_CODEX_SOCKET` selects the existing desktop control socket.
Having a bundled CLI with queue commands does not prove the desktop exposes it.

## Reply behavior

`send_message` keeps its existing arguments. Omit `conversation_id` to start a
new conversation; supply it for a substantive follow-up in an existing exchange.
Use `reply_to_message` to satisfy an incoming response obligation:

```json
{
  "message_id": "<inbound-message-uuid>",
  "message": "Which release should I check?",
  "request_id": "<stable-new-request-uuid>",
  "disposition": "continue"
}
```

| Disposition | Agent behavior |
| --- | --- |
| `continue` | Ask a question or provide an answer requiring another response, then yield. |
| `complete` | Return a finished result; do not request or generate an acknowledgement. |
| `needs_user` | Explain the human blocker and pause automatic exchanges. |

There is no conversation turn limit. Existing sender and recipient quotas still
apply. Agents send purpose-written questions, answers, results, and blockers;
they do not forward unrelated final output or transcripts. Plugin context names
the remote requester and inbound message separately from the local task that
created a child. Peer message bodies remain untrusted content.

`list_conversations` returns participant names, previews, outstanding replies,
and activity state. `get_conversation` returns both directions in sequence order;
pass `next_sequence` as `after_sequence` for the next page. A reply can reference
only an inbound message addressed to its authenticated sender. The server derives
the conversation and recipient and preserves exact-request idempotency.

`delivered` always means native acceptance. Response state is separate:
`awaiting_reply`, `replied`, `complete`, `needs_user`, or `needs_attention`.
A missing reply does not rewrite a delivered transport receipt.

## Local state and recovery

Synchronous PreToolUse records the originating session and complete outbound
intent before authenticated MCP sends, including nested tool calls. PostToolUse
checks the authenticated sender and binds its returned conversation. Receiver v2
includes the participant's earliest outbound request ID, allowing an immediate
reply to recover a binding before PostToolUse or after a lost MCP response.
The server continues to serve v1 envelopes to existing receivers.

Bindings are scoped to installation, user, and cloud conversation. SQLite stores
native task, host, checkout, send intents, delivery evidence, response obligations,
and worker leases locally. Cloud payloads never contain native IDs, local paths,
or raw transcripts. Replacing an installation does not transfer old bindings.

The child registers its session durably. The receiver independently retries
binding when transcript evidence arrives after startup. It verifies the initial
native delegation, source task, delivery marker, and Git repository. Copied peer
text or a copied user prompt is not binding evidence. Existing conversations
without proven bindings are flagged instead of creating replacement children.

A response-required turn that finishes without a reply gets one Stop repair
continuation. Duplicate Stop hooks reuse the same decision. A second failure is
`needs_attention`, with no repeated automatic restart. Resume and compaction
hooks restore private routing context. Pending sends with unknown outcomes are
retried through authenticated agent MCP using their original request IDs; the
receiver credential never gains sending permissions.

The macOS LaunchAgent runs one worker per installation, checks every two seconds,
drains batches of ten, and backs off to sixty seconds during outages. SQLite
leases fence stale workers. Native calls are durably marked before issuance.
Ambiguous native results stay fenced until evidence can be reconciled; Synapse
does not claim exactly-once native execution.

```sh
npm run synapse -- receiver start
npm run synapse -- receiver status .
npm run synapse -- receiver stop
npm run synapse -- conversation pause <conversation-id>
npm run synapse -- conversation resume <conversation-id>
```

An explicit receiver stop persists across hook wakeups. An explicit task
interruption pauses its conversations; paused queued input is rejected by the
prompt hook without restarting the agent. Resume preserves a submission that is
still waiting in the native queue. A continuation is submitted only after the
original input ran or its prompt hook consumed and rejected it while paused;
repeated interruptions use distinct continuation IDs. Automatic reply repairs
preserve queued input and fence uncertain acknowledgements the same way.
Archived, deleted, and unavailable destinations retain local messages. Restore
the destination before resuming delivery.

Receiver upgrades can enrich an unchanged v1 message that was staged before its
import was confirmed with the server's v2 conversation metadata and renewed
claim. Payload and tenant checks still apply. Confirmed or issued messages cannot
change protocol, and established conversations without proven routes remain
fenced for repair.

For an older conversation with an unproven origin, open the intended task once,
then explicitly select it:

```sh
npm run synapse -- conversation repair <conversation-id> --task <native-task-id>
```

Repair requires a registered session in the same checkout, cannot replace a
different verified binding, and cannot bypass unresolved native creation.
Inspect those failures before taking further action.

Installed plugins also provide these dependency-free controls through
`node <plugin-root>/server/control.mjs receiver start|stop|status` and
`node <plugin-root>/server/control.mjs conversation pause|resume|repair ...`.
Run conversation controls from the connected checkout. All status reads remain
local and do not send routine polling messages to users.

## Rollout and acceptance gate

1. Apply additive migrations through `202609090003_conversations.sql`.
2. Deploy server support for replies, history, authenticated send receipts, and
   negotiated receiver v2. Existing v1 receivers remain compatible.
3. Refresh the plugin on both devices, reopen their Codex tasks to load hooks,
   enroll receivers, and start the supervised services. SQLite v4 preserves
   existing verified bindings and flags unproven established routes for repair.
4. Run `npm run check` against disposable PostgreSQL, `npm run validate:plugin`,
   and `npm run audit`. Keep the newer memory and authentication migrations.
5. Complete the following controlled two-account desktop smoke test before
   treating the feature as finished or enabling the rollout broadly.

The automated acceptance test uses real PostgreSQL/RLS, HTTP/MCP, enrollment,
receiver synchronization, SQLite, hooks, and worker orchestration, with explicit
native desktop test doubles. It is not a substitute for the live test.

The live test must establish:

- Alice sends from an existing task with no manually supplied native binding.
- Bob receives exactly one child and asks a purpose-written question.
- Alice is busy when the reply arrives; native queuing waits for that turn.
- Alice answers and Bob returns a `complete` result in their existing tasks.
- Neither owner submits an additional prompt to drive the exchange.
- Completion does not start an acknowledgement loop; interruption and explicit
  resume work; disconnect/reconnect drains pending messages safely.

Record both plugin versions, receiver readiness results, automatic binding,
native task counts, busy-turn ordering, and the final round trip. Keep native
IDs and screenshots containing private task content out of cloud message bodies.
The live acceptance gate is pending until that evidence has been collected.
