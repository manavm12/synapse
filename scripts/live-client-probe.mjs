import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PROJECT_ROOT } from "../src/client/config.mjs";
import { processIsRunning } from "../src/client/process-lock.mjs";
import { addJob, readState } from "../src/client/store.mjs";
import { worktreePathForChannel } from "../src/client/worktree.mjs";

const execFileAsync = promisify(execFile);
const SECRET_MARKER = "SYNAPSE-HIDDEN-TASK-MARKER";
const temporaryRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
const probeRoot = await mkdtemp(join(temporaryRoot, "synapse-probe-"));
const statePath = join(probeRoot, "state.json");
const runtimeRoot = join(probeRoot, "runtime");
const channelId = `person-a--person-b-${Date.now()}`;
const worktreePath = worktreePathForChannel(runtimeRoot, channelId);
const probeEnvironment = {
  ...process.env,
  SYNAPSE_RUNTIME_ROOT: runtimeRoot,
  SYNAPSE_STATE_PATH: statePath,
};

async function runHook() {
  const hookPath = new URL("../src/client/hook.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [hookPath], {
    env: probeEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "probe" }));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stdout.includes(SECRET_MARKER), false, "hook leaked hidden task contents");
  return stdout;
}

async function waitForCompletion(jobId) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const state = await readState(statePath);
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "completed" && job.workerFinishedAt) {
      while (job.workerPid && processIsRunning(job.workerPid)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return state;
    }
    if (job?.status === "failed" && job.workerFinishedAt) {
      throw new Error(`Worker failed ${jobId}: ${job.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

async function stopProbeAppServer() {
  try {
    const pid = Number.parseInt(
      await readFile(join(runtimeRoot, "codex-app-server.pid"), "utf8"),
      10,
    );
    process.kill(pid, "SIGTERM");
    for (let attempt = 0; attempt < 100 && processIsRunning(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processIsRunning(pid)) {
      throw new Error(`Probe App Server ${pid} did not stop`);
    }
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes(error.code)) {
      throw error;
    }
  }
}

async function stopProcessesUsingProbeRoot() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("pgrep", ["-f", probeRoot]));
  } catch (error) {
    if (error.code === 1) {
      return;
    }
    throw error;
  }

  const pids = stdout
    .trim()
    .split("\n")
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pids.every((pid) => !processIsRunning(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Probe processes did not stop: ${pids.join(", ")}`);
}

async function cleanup(worktreePath) {
  await stopProbeAppServer();
  await stopProcessesUsingProbeRoot();
  try {
    await access(join(worktreePath, ".git"));
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: PROJECT_ROOT,
    });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  await rm(probeRoot, { recursive: true, force: true });
}

let output;
try {
  await addJob(statePath, {
    id: "job-1",
    channelId,
    sender: "person-a",
    task: `${SECRET_MARKER}: Create SYNAPSE_PROOF.md containing exactly one line: 'first-job-complete'.`,
  });

  const firstHookOutput = await runHook();
  const firstState = await waitForCompletion("job-1");
  const firstThreadId = firstState.channels[channelId].threadId;
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  await addJob(statePath, {
    id: "job-2",
    channelId,
    sender: "person-a",
    task: `${SECRET_MARKER}: Append a new line containing exactly 'follow-up-complete' to SYNAPSE_PROOF.md.`,
  });

  const secondHookOutput = await runHook();
  const finalState = await waitForCompletion("job-2");
  const finalChannel = finalState.channels[channelId];
  assert.equal(finalChannel.worktreePath, worktreePath);
  const proof = await readFile(join(worktreePath, "SYNAPSE_PROOF.md"), "utf8");

  assert.equal(finalChannel.threadId, firstThreadId, "follow-up used a different thread");
  assert.equal(proof.trim(), "first-job-complete\nfollow-up-complete");

  output = {
    firstHookOutput: JSON.parse(firstHookOutput),
    secondHookOutput: JSON.parse(secondHookOutput),
    threadId: finalChannel.threadId,
    jobs: finalState.jobs.map(({ task: _task, ...job }) => job),
    proof,
  };
} finally {
  await cleanup(worktreePath);
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
