# Local receiver

The Synapse receiver is packaged into normal Synapse setup. Setup opens an
explicit browser consent page and waits for approval; once approved, any active
signed-in Synapse user can send a task to the connected cloud project.

## Connect

The normal command installs the plugin, signs in, binds the project, and enrolls
the receiver in one resumable flow:

```sh
npm run synapse -- setup . --alias <project-alias>
```

Synapse creates the receiver credential locally, stores it in macOS Keychain,
and sends only its SHA-256 hash to the server. The credential is never printed,
placed in a browser URL, or passed as a process argument. The browser page asks
the signed-in owner to approve the project and the automatic-receiving policy.

Setup finishes enrollment automatically after approval. The lower-level commands
remain available for recovery and diagnostics:

```sh
npm run synapse -- receiver finish .
npm run synapse -- receiver status .
```

An expired unapproved pairing can be restarted with `receiver connect`; the
existing local credential is reused and remains private. Localhost HTTP is
disabled unless `SYNAPSE_ALLOW_INSECURE_RECEIVER_HTTP=1` is set explicitly for
development or tests.

## Delivery and recovery

The asynchronous owner-prompt hook checks receiver authorization, flushes
durable receipts, claims at most ten messages, and stages each message and its
import acknowledgement in one SQLite transaction. A staged message cannot be
sent to Codex until the server confirms ownership by this installation.

Native task creation and continuation are fenced on disk before the mutation.
Immediately before issuing either mutation, routing checks the current local
binding and fresh cloud authorization, then rechecks the local binding after
the network response. Disconnecting or rebinding during that check denies the
stale reservation. Revocation after the final check cannot atomically undo a
native mutation that is already being issued.
If Codex may have accepted a mutation but its response is lost or malformed,
the job becomes `needs_attention`; Synapse does not automatically repeat it.
Receipt upload failures remain in a local outbox for a later prompt. A cloud
failure never prevents legacy local messages from routing and the background
hook never blocks the foreground prompt.

Disconnecting revokes future receiver operations but cannot cancel tasks that
Codex already accepted:

```sh
npm run synapse -- receiver disconnect .
```

Disconnect also cancels an unapproved pairing or an installation whose browser
approval succeeded but whose local `finish` failed. Cancellation is repeat-safe
and prevents delayed approval of that pairing. If the network or credential
cleanup fails, rerun disconnect; durable local recovery state is retained.
Cancelled credentials cannot be reused for enrollment. A fresh connect creates
a new credential and installation-scoped conversation channels; old assigned
jobs and native task bindings are not silently transferred.
