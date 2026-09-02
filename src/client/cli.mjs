import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { queueMessage } from "../../plugins/synapse/lib/inbox.mjs";

const execFileAsync = promisify(execFile);

function usage() {
  return [
    "Usage:",
    '  npm run synapse -- send <channel-id> --project <name-or-absolute-path> "<task>"',
    "",
    "The next prompt in a local Codex task for that project routes the message.",
  ].join("\n");
}

export function parseArguments(input) {
  const arguments_ = [...input];
  if (arguments_.includes("--help") || arguments_.includes("-h") || arguments_.length === 0) {
    return { command: "help" };
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

export async function resolveProjectRoot(project, cwd = process.cwd()) {
  let candidate;
  if (isAbsolute(project)) {
    candidate = project;
  } else if (project === basename(resolve(cwd))) {
    candidate = cwd;
  } else {
    throw new Error(
      `Project ${project} is not the current folder; pass its absolute path instead`,
    );
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", resolve(candidate), "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    return resolve(stdout.trim());
  } catch {
    throw new Error(`Project is not a Git checkout: ${resolve(candidate)}`);
  }
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

export async function main(arguments_ = process.argv.slice(2)) {
  const parsed = parseArguments(arguments_);
  if (parsed.command === "help") {
    process.stdout.write(`${usage()}\n`);
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
  main().catch((error) => {
    process.stderr.write(`Synapse failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
