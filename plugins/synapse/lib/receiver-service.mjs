import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { acquireWorker } from "./conversation-store.mjs";
import { inboxPath, withInbox } from "./inbox.mjs";

const execAsync = promisify(execFile);
const label = "com.synapse.receiver";
const executable = fileURLToPath(
  new URL("../server/receiver.mjs", import.meta.url),
);

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function receiverServicePlist({
  nodePath,
  script = executable,
  stateDirectory,
  env = {},
}) {
  // Only explicit Synapse configuration enters the service environment. Never
  // copy credentials or the parent's complete process environment into a plist.
  const variables = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    ...Object.fromEntries(
      [
        "CODEX_HOME",
        "SYNAPSE_HOME",
        "SYNAPSE_HOST_DB",
        "SYNAPSE_INBOX_PATH",
        "SYNAPSE_CODEX_SOCKET",
        "SYNAPSE_ALLOW_INSECURE_RECEIVER_HTTP",
      ]
        .filter((key) => env[key])
        .map((key) => [key, env[key]]),
    ),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(script)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict>${Object.entries(variables)
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join("")}</dict>
<key>StandardOutPath</key><string>${xml(join(stateDirectory, "receiver.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(stateDirectory, "receiver-error.log"))}</string>
</dict></plist>\n`;
}

async function startService(
  { automatic = false } = {},
  {
    env = process.env,
    platform = process.platform,
    userHome = homedir(),
    uid = process.getuid?.(),
    run = execAsync,
    nodePath = env.CODEX_MCP_NODE_PATH,
    inboxOptions = { path: inboxPath(env) },
  } = {},
) {
  if (platform !== "darwin")
    throw new Error("Background receiving currently requires macOS.");
  const runtime = withInbox((database) => {
    const worker = database
      .prepare("SELECT stopped FROM receiver_workers WHERE name='receiver'")
      .get();
    if (automatic && worker?.stopped) return null;
    if (!automatic)
      database
        .prepare("UPDATE receiver_workers SET stopped=0 WHERE name='receiver'")
        .run();
    return database
      .prepare(
        "SELECT node_path FROM conversation_runtimes ORDER BY updated_at DESC LIMIT 1",
      )
      .get();
  }, inboxOptions);
  if (automatic && runtime === null) return { started: false, paused: true };
  const selectedNode = nodePath ?? runtime?.node_path;
  if (!selectedNode || !existsSync(selectedNode))
    throw new Error(
      "Open a Synapse-enabled Codex task once to register the signed desktop runtime.",
    );
  const stateDirectory = resolve(dirname(inboxOptions.path));
  const path = join(userHome, "Library", "LaunchAgents", `${label}.plist`);
  const body = receiverServicePlist({
    nodePath: selectedNode,
    stateDirectory,
    env,
  });
  let existing;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    /* First installation. */
  }
  let loaded = false;
  try {
    await run("/bin/launchctl", ["print", `gui/${uid}/${label}`], {
      timeout: 3000,
    });
    loaded = true;
  } catch {
    /* Not loaded. */
  }
  if (loaded && existing === body) return { started: true, unchanged: true };
  if (loaded)
    await run("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], {
      timeout: 5000,
    });
  await mkdir(dirname(path), { recursive: true });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o600 });
  await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, path], {
    timeout: 5000,
  });
  return { started: true };
}

export async function startReceiverService(input = {}, options = {}) {
  const inboxOptions = options.inboxOptions ?? { path: inboxPath(options.env) };
  const owner = randomUUID();
  const generation = withInbox(
    (database) => acquireWorker(database, { name: "supervisor", owner }),
    inboxOptions,
  );
  if (generation === null) return { started: false, starting: true };
  try {
    return await startService(input, { ...options, inboxOptions });
  } finally {
    withInbox(
      (database) =>
        database
          .prepare(
            "UPDATE receiver_workers SET lease_expires_at=0 WHERE name='supervisor' AND owner=?",
          )
          .run(owner),
      inboxOptions,
    );
  }
}

export async function stopReceiverService(
  _input = {},
  {
    env = process.env,
    userHome = homedir(),
    uid = process.getuid?.(),
    run = execAsync,
    inboxOptions = { path: inboxPath(env) },
  } = {},
) {
  withInbox((database) => {
    database
      .prepare(
        "INSERT OR IGNORE INTO receiver_workers(name) VALUES ('receiver')",
      )
      .run();
    database
      .prepare(
        "UPDATE receiver_workers SET stopped=1, generation=generation+1, lease_expires_at=0 WHERE name='receiver'",
      )
      .run();
  }, inboxOptions);
  try {
    await run("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], {
      timeout: 5000,
    });
  } catch (error) {
    // An absent job is already stopped. Preserve errors for an existing job.
    try {
      await run("/bin/launchctl", ["print", `gui/${uid}/${label}`], {
        timeout: 3000,
      });
    } catch {
      await rm(join(userHome, "Library", "LaunchAgents", `${label}.plist`), {
        force: true,
      });
      return { stopped: true };
    }
    throw error;
  }
  await rm(join(userHome, "Library", "LaunchAgents", `${label}.plist`), {
    force: true,
  });
  return { stopped: true };
}

export function receiverServiceStatus(
  { projectRoot } = {},
  { inboxOptions = { path: inboxPath() }, now = Date.now() } = {},
) {
  const empty = {
    running: false,
    stopped: false,
    last_success_at: null,
    error: null,
    runtime_registered: false,
    desktop_available: false,
    outstanding_replies: 0,
    outgoing_sends: [],
    conversations: [],
  };
  if (!existsSync(inboxOptions.path)) return empty;
  const database = new DatabaseSync(inboxOptions.path, { readOnly: true });
  try {
    if (
      !database
        .prepare("SELECT 1 FROM sqlite_master WHERE name='receiver_workers'")
        .get()
    )
      return empty;
    const worker = database
      .prepare(
        "SELECT stopped, lease_expires_at, last_success_at, last_error FROM receiver_workers WHERE name='receiver'",
      )
      .get();
    const session = database
      .prepare(`SELECT pipe_path, node_path, codex_path FROM conversation_runtimes
      WHERE (? IS NULL OR project_root=?) ORDER BY updated_at DESC LIMIT 1`)
      .get(projectRoot ?? null, projectRoot ?? null);
    const conversations = database
      .prepare(`SELECT cloud_conversation_id AS conversation_id, binding_state, pause_reason,
      last_reconcile_error AS error FROM channels WHERE cloud_conversation_id IS NOT NULL AND (? IS NULL OR project_root=?)`)
      .all(projectRoot ?? null, projectRoot ?? null);
    return {
      running: !!worker && !worker.stopped && worker.lease_expires_at > now,
      stopped: !!worker?.stopped,
      last_success_at: worker?.last_success_at ?? null,
      error: worker?.last_error ?? null,
      runtime_registered:
        !!session?.node_path && !!session?.pipe_path && !!session?.codex_path,
      desktop_available: !!session?.pipe_path && existsSync(session.pipe_path),
      outstanding_replies: database
        .prepare(`SELECT count(*) AS count FROM conversation_responses response JOIN jobs ON jobs.id=response.message_id
        WHERE response.status IN ('queued','active','repair','paused','needs_attention','resume_pending','resume_queued','resume_uncertain') AND (? IS NULL OR jobs.project_root=?)`)
        .get(projectRoot ?? null, projectRoot ?? null).count,
      outgoing_sends: database
        .prepare(`SELECT request_id, status, error_code FROM outgoing_intents WHERE status<>'sent'
        AND (? IS NULL OR project_root=?) ORDER BY created_at LIMIT 100`)
        .all(projectRoot ?? null, projectRoot ?? null),
      conversations,
    };
  } finally {
    database.close();
  }
}
