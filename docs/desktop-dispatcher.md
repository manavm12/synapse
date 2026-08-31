# Desktop-owned Codex conversations

Synapse messages are queued by the terminal and delivered by a Codex task in the
saved project. The desktop task is the only writer for each channel conversation.
Synapse no longer resumes that task through a detached App Server.

## Flow

1. A sender runs `npm run synapse -- send <channel-id> --project <name-or-path> "<message>"`.
2. The next prompt submitted from the project's main checkout runs the Synapse
   `UserPromptSubmit` hook and leases one queued message.
3. The project owner creates a native Codex worktree task for a new channel or
   sends a native follow-up to the task already recorded for that channel.
4. Synapse records the native task, host, and project IDs after delivery.
5. The owner can open the task, watch it work, and continue the same conversation
   directly. Later messages using the same channel ID go to that task.

The main-checkout restriction is intentional. Delivered child tasks run in linked
Git worktrees, where the hook exits without consuming another queued message.

## Local test

Start or resume a Codex task directly in the saved project checkout, then run:

```sh
npm run synapse -- send demo --project synapse "Read package.json and report the package name."
```

Submit any prompt in the project-owner task. The hook routes the queued message.
Run a follow-up with the same channel:

```sh
npm run synapse -- send demo --project synapse "Now report the required Node.js version."
```

Submit another owner prompt. The follow-up appears in the same native task.

## Current wake-up boundary

Codex hooks run during lifecycle events such as `UserPromptSubmit`; the terminal
cannot directly wake an idle desktop task or call the desktop-only native task
tools. For this local MVP, an owner prompt is the wake-up event. A relay-backed
desktop notification/wake mechanism can replace that manual event without
changing channel ownership or conversation persistence.
