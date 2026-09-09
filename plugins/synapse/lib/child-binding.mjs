import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { activateResponse } from "./conversation-store.mjs";
import { getJob, observeProvisionedThread, withInbox } from "./inbox.mjs";
import { parseDeliveryMarker } from "./markers.mjs";
import { delegationFromOutput } from "./native-evidence.mjs";

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;
const SAFE_SESSION_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

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

export function initialDelegation(transcript) {
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

export async function bindChildSession(
  input,
  { inboxOptions, waitMs = timeoutMs() } = {},
) {
  if (
    process.env.SYNAPSE_TRUST_HOOK_SESSION_ID === "0" ||
    !input ||
    !SAFE_SESSION_ID.test(input.session_id ?? "") ||
    typeof input.transcript_path !== "string" ||
    !isAbsolute(input.transcript_path)
  )
    return null;
  let commonDirectory;
  try {
    const gitDirectory = gitPath(input.cwd, "--git-dir");
    commonDirectory = gitPath(input.cwd, "--git-common-dir");
    if (gitDirectory === commonDirectory) return null;
  } catch {
    return null;
  }
  const deadline = Date.now() + waitMs;
  while (true) {
    const evidence = initialDelegation(
      await readTranscriptStart(input.transcript_path),
    );
    if (evidence.settled) {
      const delegation = evidence.delegation;
      const marker = delegation && parseDeliveryMarker(delegation.taskInput);
      if (marker?.version !== 2) return null;
      const job = getJob(marker.jobId, inboxOptions);
      if (
        job?.deliveryId !== marker.deliveryId ||
        job.ownerSessionId !== delegation.sourceThreadId ||
        !repositoriesMatch(job.projectRoot, commonDirectory)
      )
        return null;
      observeProvisionedThread(
        {
          jobId: marker.jobId,
          deliveryId: marker.deliveryId,
          threadId: input.session_id,
        },
        inboxOptions,
      );
      withInbox(
        (database) =>
          activateResponse(database, {
            messageId: marker.jobId,
            sessionId: input.session_id,
          }),
        inboxOptions,
      );
      return marker;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await pause(Math.min(POLL_INTERVAL_MS, remaining));
  }
}
