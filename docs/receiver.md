# Local receiver

The Synapse receiver is a separate, explicit opt-in after normal Synapse setup
and OAuth login. Setup does not enable incoming tasks. Once the receiver is
approved, any active signed-in Synapse user can send a task to the connected
cloud project.

## Connect

From the project's primary checkout, start enrollment against the Synapse HTTPS
service:

```sh
npm run synapse -- receiver connect . --server-url https://synapse.example
```

Synapse creates the receiver credential locally, stores it in macOS Keychain,
and sends only its SHA-256 hash to the server. The credential is never printed,
placed in a browser URL, or passed as a process argument. The browser page asks
the signed-in owner to approve the project and the automatic-receiving policy.

After approval, finish the resumable enrollment:

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
