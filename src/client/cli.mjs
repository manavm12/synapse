import { randomUUID } from "node:crypto";

import {
  getJob,
  queueMessage,
  recoverMessage,
} from "../../plugins/synapse/lib/inbox.mjs";
import {
  configureMcpResource,
  createDevelopmentToken,
  inviteUser,
  revokeDevelopmentToken,
  rotateRuntimeRole,
} from "../admin.mjs";
import { formatDoctorReport, runDoctor } from "./doctor.mjs";
import { connectProject, resolveProjectRoot } from "./project-registry.mjs";
import {
  disconnectReceiver,
  finishReceiverConnection,
  receiverStatus,
  startReceiverConnection,
} from "./receiver/enrollment.mjs";
import { formatSetupResult, runSetup } from "./setup.mjs";

export { resolveProjectRoot };

function usage() {
  return [
    "Usage:",
    "  npm run synapse -- setup [project-path] --alias <cloud-project-alias> [--login]",
    "  npm run synapse -- doctor [project-path] [--alias <cloud-project-alias>] [--json]",
    '  npm run synapse -- send <channel-id> --project <name-or-absolute-path> "<task>"',
    "  npm run synapse -- status <job-id>",
    "  npm run synapse -- recover <job-id> --owner-stopped",
    "  npm run synapse -- project connect [path] --alias <cloud-project-alias>",
    "  npm run synapse -- receiver connect [path] --server-url <https://host> [--no-open]",
    "  npm run synapse -- receiver finish [path]",
    "  npm run synapse -- receiver status [path]",
    "  npm run synapse -- receiver disconnect [path]",
    "  npm run synapse -- admin invite --email <email> --username <name> --project <alias>",
    "  npm run synapse -- admin token create --username <name> [--expires-in-days <days>]",
    "  npm run synapse -- admin token revoke --token-id <uuid>",
    "  npm run synapse -- admin configure --mcp-url <https://host/mcp>",
    "  npm run synapse -- admin runtime-role rotate",
    "",
    "The next prompt in a local Codex task for that project routes the message.",
  ].join("\n");
}

function parseOptions(arguments_, offset, definitions) {
  const values = {};
  for (let index = offset; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const definition = definitions[option];
    const value = arguments_[index + 1];
    if (
      !definition ||
      Object.hasOwn(values, definition.key) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error(usage());
    }
    values[definition.key] = value;
  }
  for (const definition of Object.values(definitions)) {
    if (definition.required && !Object.hasOwn(values, definition.key)) {
      throw new Error(usage());
    }
  }
  return values;
}

export function parseArguments(input) {
  const arguments_ = [...input];
  if (
    arguments_.includes("--help") ||
    arguments_.includes("-h") ||
    arguments_.length === 0
  ) {
    return { command: "help" };
  }
  if (arguments_[0] === "recover") {
    const [, jobId, confirmation, ...extra] = arguments_;
    if (!jobId || confirmation !== "--owner-stopped" || extra.length > 0) {
      throw new Error(usage());
    }
    return { command: "recover", jobId };
  }
  if (arguments_[0] === "status") {
    const [, jobId, ...extra] = arguments_;
    if (!jobId || extra.length > 0) throw new Error(usage());
    return { command: "status", jobId };
  }
  if (arguments_[0] === "setup" || arguments_[0] === "doctor") {
    const command = arguments_.shift();
    const forceLogin = command === "setup" && arguments_.includes("--login");
    const json = command === "doctor" && arguments_.includes("--json");
    if (forceLogin) arguments_.splice(arguments_.indexOf("--login"), 1);
    if (json) arguments_.splice(arguments_.indexOf("--json"), 1);
    const aliasIndex = arguments_.indexOf("--alias");
    const alias = aliasIndex === -1 ? undefined : arguments_[aliasIndex + 1];
    if (aliasIndex !== -1) {
      if (!alias || alias.startsWith("--")) throw new Error(usage());
      arguments_.splice(aliasIndex, 2);
    }
    if ((command === "setup" && !alias) || arguments_.length > 1) {
      throw new Error(usage());
    }
    return {
      command,
      project: arguments_[0] ?? ".",
      ...(alias ? { alias } : {}),
      ...(command === "setup" ? { forceLogin } : { json }),
    };
  }
  if (arguments_[0] === "project" && arguments_[1] === "connect") {
    const aliasIndex = arguments_.indexOf("--alias");
    const alias = aliasIndex === -1 ? null : arguments_[aliasIndex + 1];
    if (!alias) throw new Error(usage());
    arguments_.splice(aliasIndex, 2);
    const project = arguments_[2] ?? ".";
    if (arguments_.length > 3) throw new Error(usage());
    return { command: "project-connect", alias, project };
  }
  if (arguments_[0] === "receiver") {
    const action = arguments_[1];
    if (action === "connect") {
      const serverIndex = arguments_.indexOf("--server-url");
      const serverUrl = serverIndex === -1 ? null : arguments_[serverIndex + 1];
      if (!serverUrl || serverUrl.startsWith("--")) throw new Error(usage());
      arguments_.splice(serverIndex, 2);
      const openBrowser = !arguments_.includes("--no-open");
      if (!openBrowser) arguments_.splice(arguments_.indexOf("--no-open"), 1);
      if (arguments_.length > 3) throw new Error(usage());
      return {
        command: "receiver-connect",
        project: arguments_[2] ?? ".",
        serverUrl,
        openBrowser,
      };
    }
    if (
      ["finish", "status", "disconnect"].includes(action) &&
      arguments_.length <= 3
    ) {
      return {
        command: `receiver-${action}`,
        project: arguments_[2] ?? ".",
      };
    }
    throw new Error(usage());
  }
  if (arguments_[0] === "admin") {
    if (arguments_[1] === "invite") {
      const options = parseOptions(arguments_, 2, {
        "--email": { key: "email", required: true },
        "--username": { key: "username", required: true },
        "--project": { key: "projectAlias", required: true },
      });
      return {
        command: "admin-invite",
        ...options,
      };
    }
    if (arguments_[1] === "token" && arguments_[2] === "create") {
      const options = parseOptions(arguments_, 3, {
        "--username": { key: "username", required: true },
        "--expires-in-days": { key: "expiresInDays" },
        "--label": { key: "label" },
      });
      return {
        command: "admin-token-create",
        ...options,
        expiresInDays: options.expiresInDays ?? "7",
        label: options.label ?? "local-development",
      };
    }
    if (arguments_[1] === "token" && arguments_[2] === "revoke") {
      return {
        command: "admin-token-revoke",
        ...parseOptions(arguments_, 3, {
          "--token-id": { key: "tokenId", required: true },
        }),
      };
    }
    if (arguments_[1] === "configure") {
      return {
        command: "admin-configure",
        ...parseOptions(arguments_, 2, {
          "--mcp-url": { key: "mcpUrl", required: true },
        }),
      };
    }
    if (
      arguments_[1] === "runtime-role" &&
      arguments_[2] === "rotate" &&
      arguments_.length === 3
    ) {
      return { command: "admin-runtime-role-rotate" };
    }
    throw new Error(usage());
  }
  const projectIndex = arguments_.indexOf("--project");
  const project = projectIndex === -1 ? null : arguments_[projectIndex + 1];
  if (projectIndex !== -1) {
    arguments_.splice(projectIndex, 2);
  }
  const [command, channelId, ...taskParts] = arguments_;
  const task = taskParts.join(" ").trim();
  if (command !== "send" || !channelId || !project || !task) {
    throw new Error(usage());
  }
  return { command, channelId, project, task };
}

export async function sendMessage(
  { channelId, project, task, cwd = process.cwd() },
  { createId = randomUUID, queue = queueMessage } = {},
) {
  const projectRoot = await resolveProjectRoot(project, cwd);
  return queue({
    id: createId(),
    channelId,
    task,
    projectRoot,
  });
}

export async function main(
  arguments_ = process.argv.slice(2),
  {
    setup = runSetup,
    doctor = runDoctor,
    receiverStart = startReceiverConnection,
    receiverFinish = finishReceiverConnection,
    getReceiverStatus = receiverStatus,
    receiverDisconnect = disconnectReceiver,
  } = {},
) {
  const parsed = parseArguments(arguments_);
  if (parsed.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.command === "recover") {
    const message = recoverMessage({
      jobId: parsed.jobId,
      ownerStopped: true,
    });
    process.stdout.write(
      `Recovered ${message.jobId}; the next owner prompt may retry it safely.\n`,
    );
    return;
  }
  if (parsed.command === "status") {
    const message = getJob(parsed.jobId);
    if (!message) throw new Error(`Unknown job: ${parsed.jobId}`);
    process.stdout.write(`${JSON.stringify(message, null, 2)}\n`);
    return;
  }
  if (parsed.command === "setup") {
    const result = await setup(parsed);
    process.stdout.write(formatSetupResult(result));
    return { ok: true };
  }
  if (parsed.command === "doctor") {
    const result = await doctor(parsed);
    process.stdout.write(
      parsed.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : formatDoctorReport(result),
    );
    return result;
  }
  if (parsed.command === "project-connect") {
    const project = await connectProject(parsed);
    process.stdout.write(
      `Connected ${project.alias} to ${project.root}${project.created ? "" : " (already connected)"}\n`,
    );
    return;
  }
  if (parsed.command === "receiver-connect") {
    const connection = await receiverStart(parsed, {
      openBrowser: parsed.openBrowser,
    });
    process.stdout.write(
      `Receiver pairing ${connection.pairingId} is pending. Approve it at ${connection.verificationUrl}, then run receiver finish.\n`,
    );
    return;
  }
  if (parsed.command === "receiver-finish") {
    const connection = await receiverFinish(parsed);
    process.stdout.write(
      connection.status === "connected"
        ? `Receiver connected as @${connection.identity.username} to ${connection.identity.projectAlias}; credential expires ${connection.identity.expiresAt}.\n`
        : "Receiver approval is still pending.\n",
    );
    return;
  }
  if (parsed.command === "receiver-status") {
    const connection = await getReceiverStatus(parsed);
    const status = !connection
      ? { status: "not_connected" }
      : {
          status: connection.status,
          projectRoot: connection.projectRoot,
          projectAlias: connection.projectAlias,
          serverUrl: connection.serverUrl,
          pairingId: connection.pairingId,
          pairingExpiresAt: connection.pairingExpiresAt,
          identity: connection.identity,
        };
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (parsed.command === "receiver-disconnect") {
    await receiverDisconnect(parsed);
    process.stdout.write(
      "Receiver disconnected. Already-dispatched tasks were not canceled.\n",
    );
    return;
  }
  if (parsed.command === "admin-invite") {
    process.stdout.write(
      `${JSON.stringify(await inviteUser(parsed), null, 2)}\n`,
    );
    return;
  }
  if (parsed.command === "admin-token-create") {
    process.stdout.write(
      `${JSON.stringify(await createDevelopmentToken(parsed), null, 2)}\n`,
    );
    return;
  }
  if (parsed.command === "admin-token-revoke") {
    process.stdout.write(
      `${JSON.stringify(await revokeDevelopmentToken(parsed), null, 2)}\n`,
    );
    return;
  }
  if (parsed.command === "admin-configure") {
    process.stdout.write(
      `${JSON.stringify(await configureMcpResource(parsed), null, 2)}\n`,
    );
    return;
  }
  if (parsed.command === "admin-runtime-role-rotate") {
    process.stdout.write(
      `${JSON.stringify(await rotateRuntimeRole(parsed), null, 2)}\n`,
    );
    return;
  }
  const message = await sendMessage(parsed);
  process.stdout.write(
    [
      "",
      `Queued: ${message.jobId}`,
      `Channel: ${message.channelId}`,
      `Project: ${message.projectRoot}`,
      "Delivery: send your next message in a local Codex task for this project.",
      "",
    ].join("\n"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((result) => {
      if (result?.ok === false) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`Synapse failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
