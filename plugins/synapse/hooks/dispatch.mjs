import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { reserveNextMessage } from "../lib/inbox.mjs";
import { runReservedDelivery } from "../lib/native-router.mjs";
import { syncReceiver } from "../lib/receiver-sync.mjs";

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const SAFE_SESSION_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_HOOK_INPUT_BYTES) throw new Error("Hook input is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function gitPath(cwd, argument) {
  const value = execFileSync("git", ["-C", cwd, "rev-parse", argument], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return isAbsolute(value) ? value : resolve(cwd, value);
}

let input;
try {
  input = JSON.parse((await readStdin()) || "{}");
} catch {
  process.exit(0);
}
if (
  !input ||
  Array.isArray(input) ||
  typeof input !== "object" ||
  input.hook_event_name !== "UserPromptSubmit" ||
  typeof input.cwd !== "string" ||
  !input.cwd ||
  input.cwd.length > 4096 ||
  typeof input.session_id !== "string" ||
  !SAFE_SESSION_ID.test(input.session_id)
)
  process.exit(0);

let gitDirectory;
let commonDirectory;
let projectRoot;
try {
  gitDirectory = gitPath(input.cwd, "--git-dir");
  commonDirectory = gitPath(input.cwd, "--git-common-dir");
  projectRoot = gitPath(input.cwd, "--show-toplevel");
} catch {
  process.exit(0);
}
if (gitDirectory !== commonDirectory) process.exit(0);

let receiverAuthorized = false;
try {
  const receiver = await syncReceiver({ projectRoot });
  receiverAuthorized = receiver.authorized;
} catch {
  // Receiver transport is best-effort and must never delay or block the owner prompt.
}

const delivery = reserveNextMessage(
  {
    projectRoot,
    ownerSessionId: input.session_id,
  },
  { allowCloud: receiverAuthorized },
);
if (!delivery) process.exit(0);

try {
  await runReservedDelivery({
    jobId: delivery.jobId,
    deliveryId: delivery.deliveryId,
    ownerThreadId: input.session_id,
    turnId:
      typeof input.turn_id === "string" && SAFE_SESSION_ID.test(input.turn_id)
        ? input.turn_id
        : undefined,
  });
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      event: "synapse_native_route_failed",
      jobId: delivery.jobId,
      message: error.message,
    })}\n`,
  );
}
