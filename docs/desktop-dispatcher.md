# Desktop-owned Codex conversations

Synapse messages are queued by the terminal and delivered automatically by a
scheduled Codex task in the saved project. The desktop task is the only writer
for each channel conversation. Synapse never resumes that task through a
detached App Server.

## Flow

1. A sender runs `npm run synapse -- send <channel-id> --project <name-or-path> "<message>"`.
2. The scheduled `Synapse Dispatcher` task wakes once per minute in the project's
   main checkout and leases one queued message with `dispatcher-next`.
3. The dispatcher creates a native Codex worktree task for a new channel or
   sends a native follow-up to the task already recorded for that channel.
4. Synapse records the native task, host, and project IDs after delivery.
5. The owner can open the task, watch it work, and continue the same conversation
   directly. Later messages using the same channel ID go to that task.

The main-checkout restriction is intentional. The dispatcher runs directly in
the saved project. Delivered child tasks run in linked Git worktrees, where the
hook exits without recursively consuming another queued message.

## One-time setup

From a Codex task running directly in the saved project, ask:

```text
Set up the automatic Synapse dispatcher for this project.
```

Codex creates one local project task titled `Synapse Dispatcher` and attaches a
one-minute heartbeat to it. Keep the desktop app running when local messages need
to be delivered. Routine empty-inbox runs notify only on failure.

## Local test

After the one-time dispatcher setup, run:

```sh
npm run synapse -- send demo --project synapse "Read package.json and report the package name."
```

Within roughly one minute, a `Synapse: demo` worktree task appears under the saved
project without another prompt. Run a follow-up with the same channel:

```sh
npm run synapse -- send demo --project synapse "Now report the required Node.js version."
```

The follow-up appears automatically in the same native task and worktree.

## Wake-up boundary

The terminal cannot directly wake an idle desktop task or call the desktop-only
native task tools. The scheduled dispatcher supplies the wake-up automatically
and then leases work through the CLI. This adds polling latency; a delivery
normally starts within one minute, while native task creation and execution take
additional time. A future native Synapse event trigger can make delivery
immediate without changing channel ownership or conversation persistence.
