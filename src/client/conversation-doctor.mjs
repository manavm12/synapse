import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { inboxPath } from "../../plugins/synapse/lib/inbox.mjs";
import { NativeQueueClient } from "../../plugins/synapse/lib/native-queue.mjs";
import { receiverServiceStatus } from "../../plugins/synapse/lib/receiver-service.mjs";

export async function inspectConversations(
  { root, repositoryRoot },
  {
    env = process.env,
    run = promisify(execFile),
    queueClient = (options) => new NativeQueueClient(options),
  } = {},
) {
  const hooks = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "plugins/synapse/hooks/hooks.json"),
      "utf8",
    ),
  ).hooks;
  const hasHook = (event) =>
    hooks[event]?.some((entry) =>
      entry.hooks?.some(
        (hook) =>
          hook.command.includes("/hooks/conversation.mjs") && !hook.async,
      ),
    );
  const hooksReady = [
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "Interrupt",
    "SessionStart",
    "UserPromptSubmit",
  ].every(hasHook);
  const checks = [
    {
      id: "conversation-hooks",
      status: hooksReady ? "pass" : "fail",
      summary: hooksReady
        ? "Synchronous conversation hooks are configured"
        : "Conversation lifecycle hooks are missing",
      detail:
        "Codex must support nested MCP PreToolUse/PostToolUse, Stop repair, Interrupt, and resume context. Validate execution in the desktop smoke test.",
    },
  ];
  const path = inboxPath(env);
  const status = receiverServiceStatus(
    { projectRoot: root },
    { inboxOptions: { path } },
  );
  checks.push({
    id: "receiver",
    status: status.running && !status.error ? "pass" : "warn",
    summary: status.running
      ? `Receiver running; ${status.outstanding_replies} outstanding replies`
      : "Background receiver is not ready",
    detail: status.error ?? undefined,
    remedy: status.running
      ? undefined
      : "Enroll the receiver, open a Codex task, then run receiver start.",
  });
  let session;
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='conversation_sessions'",
          )
          .get()
      )
        session = db
          .prepare(
            "SELECT * FROM conversation_runtimes WHERE project_root=? ORDER BY updated_at DESC LIMIT 1",
          )
          .get(root);
    } finally {
      db.close();
    }
  }
  if (!session?.node_path || !session?.pipe_path || !session?.codex_path) {
    checks.push({
      id: "desktop-conversations",
      status: "warn",
      summary: "Signed desktop runtime and native queue have not been verified",
      remedy:
        "Open a Synapse-enabled Codex task for this project, then rerun doctor.",
    });
    return { ready: false, checks };
  }
  try {
    const module = new URL(
      "../../plugins/synapse/lib/app-tools-client.mjs",
      import.meta.url,
    ).href;
    const source = `import { AppToolsClient } from ${JSON.stringify(module)}; const c=new AppToolsClient(); try { const tools=await c.listTools(); process.stdout.write(JSON.stringify(tools.map(t=>t.name))); } finally {await c.close();}`;
    const { stdout } = await run(
      session.node_path,
      ["--input-type=module", "-e", source],
      {
        env: { ...env, CODEX_APP_TOOLS_PIPE_PATH: session.pipe_path },
        timeout: 5000,
        maxBuffer: 65536,
      },
    );
    const names = JSON.parse(stdout);
    if (
      !["create_thread", "list_projects"].every((name) => names.includes(name))
    )
      throw new Error("Required desktop tools unavailable");
    checks.push({
      id: "signed-runtime",
      status: "pass",
      summary: "Signed runtime can access desktop task tools",
    });
  } catch {
    checks.push({
      id: "signed-runtime",
      status: "fail",
      summary: "Signed runtime cannot access desktop task tools",
      remedy:
        "Reconnect Codex and reopen a task to register the current connection.",
    });
  }
  const queue = queueClient({
    codexPath: session.codex_path,
    socketPath: env.SYNAPSE_CODEX_SOCKET,
    timeoutMs: 3000,
  });
  try {
    await queue.prepare(session.session_id);
    checks.push({
      id: "native-queue",
      status: "pass",
      summary: "Existing desktop daemon supports queued submissions",
    });
  } catch {
    checks.push({
      id: "native-queue",
      status: "fail",
      summary:
        "Desktop queue connection is unavailable; messages remain queued locally",
      remedy:
        "Use a Codex desktop with an accessible app-server control socket and thread/queue support. SYNAPSE_CODEX_SOCKET may select its existing control socket.",
    });
  } finally {
    queue.close();
  }
  return {
    ready:
      status.running &&
      !status.error &&
      checks.every((check) => check.status === "pass"),
    checks,
  };
}
