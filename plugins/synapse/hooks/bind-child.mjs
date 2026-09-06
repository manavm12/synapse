import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { getJob, observeProvisionedThread } from "../lib/inbox.mjs";
import { parseDeliveryMarker } from "../lib/markers.mjs";

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;
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

function repositoriesMatch(projectRoot, commonDirectory) {
  try {
    return (
      realpathSync(gitPath(projectRoot, "--git-common-dir")) ===
      realpathSync(commonDirectory)
    );
  } catch {
    return false;
  }
}

function decodeXmlText(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function delegationFromOutput(output) {
  const text =
    typeof output === "string"
      ? output
      : typeof output?.text === "string"
        ? output.text
        : null;
  if (!text?.includes("<codex_delegation>")) return null;
  const source = text.match(/<source_thread_id>([^<]+)<\/source_thread_id>/);
  const taskInput = text.match(/<input>([\s\S]*?)<\/input>/);
  if (!source || !taskInput) return null;
  return {
    sourceThreadId: decodeXmlText(source[1]).trim(),
    taskInput: decodeXmlText(taskInput[1]),
  };
}

function initialDelegation(transcript) {
  for (const line of transcript.split("\n")) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "response_item") continue;
    const item = record.payload;
    if (item?.type === "message") {
      const contentKinds =
        item.internal_chat_message_metadata_passthrough?.content_item_kinds;
      if (
        item.role === "user" &&
        Array.isArray(contentKinds) &&
        contentKinds.some((kind) => kind.startsWith("user."))
      ) {
        return { settled: true, delegation: null };
      }
      if (item.role === "assistant") {
        return { settled: true, delegation: null };
      }
      continue;
    }
    if (item?.type !== "function_call_output") continue;
    if (item.namespace !== "codex_app" || item.name !== "create_thread") {
      return { settled: true, delegation: null };
    }
    return { settled: true, delegation: delegationFromOutput(item.output) };
  }
  return { settled: false, delegation: null };
}

async function readTranscriptStart(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(MAX_TRANSCRIPT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_TRANSCRIPT_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  } finally {
    await handle?.close();
  }
}

function timeoutMs(env = process.env) {
  const configured = Number.parseInt(
    env.SYNAPSE_CHILD_BIND_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isSafeInteger(configured) && configured >= 0
    ? Math.min(configured, 30_000)
    : DEFAULT_TIMEOUT_MS;
}

function pause(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

let input;
try {
  input = JSON.parse((await readStdin()) || "{}");
} catch {
  process.exit(0);
}

if (
  process.env.SYNAPSE_TRUST_HOOK_SESSION_ID === "0" ||
  !input ||
  Array.isArray(input) ||
  typeof input !== "object" ||
  input.hook_event_name !== "SessionStart" ||
  input.source !== "startup" ||
  typeof input.cwd !== "string" ||
  !input.cwd ||
  input.cwd.length > 4096 ||
  typeof input.transcript_path !== "string" ||
  !isAbsolute(input.transcript_path) ||
  typeof input.session_id !== "string" ||
  !SAFE_SESSION_ID.test(input.session_id)
)
  process.exit(0);

let commonDirectory;
try {
  const gitDirectory = gitPath(input.cwd, "--git-dir");
  commonDirectory = gitPath(input.cwd, "--git-common-dir");
  if (gitDirectory === commonDirectory) process.exit(0);
} catch {
  process.exit(0);
}

const deadline = Date.now() + timeoutMs();
while (true) {
  try {
    const evidence = initialDelegation(
      await readTranscriptStart(input.transcript_path),
    );
    if (evidence.settled) {
      if (!evidence.delegation) break;
      const marker = parseDeliveryMarker(evidence.delegation.taskInput);
      if (marker?.version !== 2) break;
      const job = getJob(marker.jobId);
      if (
        job?.deliveryId === marker.deliveryId &&
        job.ownerSessionId === evidence.delegation.sourceThreadId &&
        repositoriesMatch(job.projectRoot, commonDirectory)
      ) {
        observeProvisionedThread({
          jobId: marker.jobId,
          deliveryId: marker.deliveryId,
          threadId: input.session_id,
        });
      }
      break;
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "synapse_child_binding_failed",
        sessionId: input.session_id,
        message: error.message,
      })}\n`,
    );
    break;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) break;
  await pause(Math.min(POLL_INTERVAL_MS, remaining));
}
