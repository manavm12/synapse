import { execFile } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppToolsClient, appToolJson } from "./app-tools-client.mjs";
import { waitForApproval, withDeadline } from "./deadline.mjs";
import {
  listPendingNativeBindings,
  observeProvisionedThread,
} from "./inbox.mjs";
import { delegationMatches } from "./native-evidence.mjs";

const exec = promisify(execFile);
const THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A read-only compatibility adapter, not evidence of delivery. The native API's
// delegation record and Git ancestry must independently confirm this candidate.
// Unknown/changed formats fail closed; never invent an ID or replay creation.
export async function resolveClientThreadId(
  clientThreadId,
  { env = process.env, signal } = {},
) {
  signal?.throwIfAborted();
  let file;
  try {
    file = await open(
      join(
        env.CODEX_HOME ?? join(homedir(), ".codex"),
        ".codex-global-state.json",
      ),
      "r",
    );
    const size = (await file.stat()).size;
    if (size > 8 * 1024 * 1024) return null;
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    signal?.throwIfAborted();
    // A concurrently rewritten file is retried later, never read unboundedly.
    if (bytesRead !== size) return null;
    const state = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    const entries = state?.["electron-persisted-atom-state"];
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      return null;
    const candidates = [];
    for (const [key, value] of Object.entries(entries)) {
      if (value !== clientThreadId || !key.startsWith("thread-client-id-v1:"))
        continue;
      const id = decodeURIComponent(key.slice("thread-client-id-v1:".length));
      if (id.startsWith("local:") && THREAD_ID.test(id.slice(6)))
        candidates.push(id.slice(6));
    }
    return candidates.length === 1 ? candidates[0] : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  } finally {
    await file?.close();
  }
}

async function matchingWorktree(projectRoot, cwd, signal) {
  if (typeof cwd !== "string" || !cwd || cwd.length > 4096) return false;
  const gitPath = async (root, flag) => {
    const { stdout } = await exec(
      "git",
      ["-C", root, "rev-parse", "--path-format=absolute", flag],
      { signal },
    );
    return realpath(stdout.trim());
  };
  const [expected, common, directory] = await Promise.all([
    gitPath(projectRoot, "--git-common-dir"),
    gitPath(cwd, "--git-common-dir"),
    gitPath(cwd, "--git-dir"),
  ]);
  return expected === common && directory !== common;
}

export function hasNativeDelegation(result, job, threadId) {
  return (
    result?.thread?.id === threadId &&
    result.thread.kind === "codex" &&
    result.thread.hostId === "local" &&
    (result.turns ?? []).some((turn) =>
      (turn.items ?? []).some(
        (item) =>
          item.type === "functionCallOutput" &&
          item.namespace === "codex_app" &&
          item.name === "create_thread" &&
          delegationMatches(job, item.output),
      ),
    )
  );
}

export async function reconcileNativeBindings(
  { projectRoot, installationId, ownerThreadId },
  {
    inboxOptions,
    env = process.env,
    signal,
    waitMs = 0,
    resolveId = resolveClientThreadId,
    verifyWorktree = matchingWorktree,
    createClient = (options) =>
      new AppToolsClient({ ...options, timeoutMs: 2500 }),
    observe = (input) => observeProvisionedThread(input, inboxOptions),
  } = {},
) {
  const jobs = listPendingNativeBindings(
    { projectRoot, installationId },
    inboxOptions,
  );
  if (jobs.length === 0) return { reconciled: 0, pending: 0 };
  let reconciled = 0;
  try {
    await withDeadline(
      async (boundedSignal) => {
        const client = createClient({ signal: boundedSignal });
        try {
          for (const job of jobs) {
            do {
              boundedSignal.throwIfAborted();
              const threadId = await resolveId(job.clientThreadId, {
                env,
                signal: boundedSignal,
              });
              if (threadId) {
                const result = appToolJson(
                  await client.callTool(
                    "read_thread",
                    {
                      threadId,
                      hostId: "local",
                      turnLimit: 1,
                      includeOutputs: true,
                      maxOutputCharsPerItem: 20000,
                    },
                    { threadId: ownerThreadId },
                  ),
                );
                if (
                  hasNativeDelegation(result, job, threadId) &&
                  (await verifyWorktree(
                    job.projectRoot,
                    result.thread.cwd,
                    boundedSignal,
                  ))
                ) {
                  boundedSignal.throwIfAborted();
                  observe({
                    jobId: job.jobId,
                    deliveryId: job.deliveryId,
                    threadId,
                  });
                  reconciled += 1;
                  break;
                }
                // A settled nonmatching task is never sufficient evidence.
                if (result?.turns?.length) break;
              }
              if (!waitMs) break;
              await waitForApproval(250, boundedSignal);
            } while (!boundedSignal.aborted);
          }
        } finally {
          await client.close();
        }
      },
      { timeoutMs: waitMs || 3000, signal },
    );
  } catch {
    signal?.throwIfAborted();
    // Provisioning, a restart, unavailable native API, and format drift all keep
    // the existing durable accepted fence. A later owner prompt retries READS.
  }
  return { reconciled, pending: jobs.length - reconciled };
}
