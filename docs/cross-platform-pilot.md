# Cross-platform conversation pilot

Status: prepared, live Windows-involved matrix pending.

This is the acceptance procedure for proving that a Synapse request can start on
one supported desktop, create exactly one native task on another desktop, and
complete a multi-turn exchange back in the original task. Unit tests and isolated
component checks do not count as a live matrix result.

## Existing evidence to reuse

- Mac-to-Mac has already been reported as a successful two-account live rollout.
- Windows hook execution, native task creation, DPAPI credential storage, and the
  Task Scheduler receiver lifecycle have each been exercised on real Windows.
- Linux CI covers the shared server/plugin behavior, but no Linux desktop is part
  of this pilot.

The missing evidence is the assembled, real-account conversation path when a
Windows desktop participates.

## Preconditions

For every participant:

1. Use a consenting test account with a unique Synapse username.
2. Use a compatible current Codex desktop and the same reviewed Synapse plugin
   release. Record versions, never credential material.
3. Select a saved local Git project and enable incoming tasks through the
   installed Synapse setup skill.
4. Trust that installed plugin's hooks, open a fresh task, and verify receiver
   setup status. Repository CLI setup or a manually invoked hook is not a
   substitute.
5. Run the read-only doctor/status checks and require `conversations_ready` plus
   an accessible native queue before sending.
6. Confirm the production server has the migrations through
   `202609090003_conversations.sql` and matching conversation endpoints.

Stop before sending if enrollment is expired/revoked, hook verification is
pending, the native queue is unavailable, the plugin builds differ unexpectedly,
or either owner withdraws consent.

## Matrix

Run each row with a new channel and request ID. Mac-to-Mac is the reference run;
do not repeat it unless the current release differs from the recorded baseline.

| Sender | Recipient | Status | Purpose |
| --- | --- | --- | --- |
| Mac | Mac | Existing reference | Confirm expected task/reply behavior from prior evidence |
| Mac | Windows | Pending | Prove Windows enrollment, import, task creation, and reply |
| Windows | Mac | Pending | Prove Windows origin binding and return delivery |
| Windows | Windows | Pending | Prove the complete Windows-native path between real accounts |

## Required conversation scenario

Use a harmless, purpose-written repository question that needs one clarification.
Do not include credentials, local paths, native task IDs, private transcripts, or
unrelated task context.

1. Alice sends from an existing Codex task without supplying a native binding.
2. Bob's receiver creates exactly one child task in the selected Git project.
3. Bob's agent sends one relevant clarification using `reply_to_message` with
   disposition `continue`.
4. Keep Alice's task busy when the clarification arrives. Confirm it queues and
   is delivered only when safe, without another owner prompt.
5. Alice answers from the original task. Bob receives it in the existing child.
6. Bob returns a finished result with disposition `complete`.
7. Alice receives the result in the original task. No acknowledgement loop or
   second child is created.

For one Windows-involved row, interrupt and explicitly resume the conversation.
For another, restart the recipient receiver between messages and confirm queued
work drains without duplicate native execution. Disconnect/reconnect testing must
preserve queued work and requires explicit owner approval before revocation.

## Pass criteria

- Both devices reported ready before the initial send.
- Exactly one native recipient task was created.
- Every message remained in one cloud conversation and the intended existing
  native tasks.
- Busy-task ordering was preserved.
- The final response reached Alice's original task without manual forwarding.
- Completion caused no acknowledgement loop.
- Interruption/resume and receiver restart caused no loss or duplicate execution.
- Cloud status and local status agreed, or any temporary difference reconciled.
- No sensitive local metadata entered cloud payloads, logs, screenshots, or Git.

Any ambiguous native mutation, conflicting binding, unexpected second task, or
manual copy/paste required for delivery is a failure, not a partial pass.

## Safe evidence record

Record only:

- date/time and direction;
- operating-system and Codex/plugin versions;
- anonymized account labels (Alice/Bob), not emails;
- readiness pass/fail and public cloud status transitions;
- task count, conversation sequence count, and whether original/child tasks were
  reused;
- busy ordering, restart, interruption/resume, completion-loop result;
- sanitized error category and the reviewed commit containing any fix.

Keep message bodies, usernames when private, access tokens, receiver credentials,
local paths, database URLs, native task IDs, and screenshots of private content
out of the committed record.

## Completion boundary

The cross-platform claim is complete only when every pending matrix row passes on
real desktops. A locally green suite, Linux CI, or separate Windows component
proof remains supporting evidence, not a substitute for this live gate.
