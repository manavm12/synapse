import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import {
  ensureSharedAppServer,
  hasOtherLiveWorkers,
  stopSharedAppServerIfIdle,
} from "../../src/client/shared-app-server.mjs";

test("another live worker prevents App Server shutdown", async () => {
  const state = {
    jobs: [
      {
        id: "job-2",
        dispatchId: "dispatch-2",
        workerPid: 123,
        workerFinishedAt: null,
      },
    ],
  };

  assert.equal(
    hasOtherLiveWorkers(
      state,
      { jobId: "job-1", dispatchId: "dispatch-1" },
      () => true,
    ),
    true,
  );
});

test("an in-progress dead-worker recovery prevents App Server shutdown", () => {
  const state = {
    jobs: [
      {
        id: "job-2",
        dispatchId: "dispatch-2",
        status: "recovering",
        workerPid: 456,
        workerFinishedAt: null,
      },
    ],
  };

  assert.equal(
    hasOtherLiveWorkers(
      state,
      { jobId: "job-1", dispatchId: "dispatch-1" },
      () => false,
    ),
    true,
  );
});

test("an idle App Server is stopped so the desktop can load its threads", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "synapse-server-test-"));
  const socketPath = join(runtimeRoot, "codex-app-server.sock");
  const pidPath = join(runtimeRoot, "codex-app-server.pid");
  const serverScript = [
    'import net from "node:net";',
    "const server = net.createServer();",
    'server.listen(process.argv[1], () => process.stdout.write("ready\\n"));',
  ].join("");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", serverScript, socketPath],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = once(child, "exit");
  await once(child.stdout, "data");
  await writeFile(pidPath, `${JSON.stringify({ pid: child.pid, startMarker: "test-start" })}\n`, "utf8");

  const stopped = await stopSharedAppServerIfIdle(
    {
      statePath: join(runtimeRoot, "state.json"),
      runtimeRoot,
      jobId: "job-1",
      dispatchId: "dispatch-1",
    },
    {
      readCurrentState: async () => ({ jobs: [] }),
      getProcessStartMarker: async () => "test-start",
    },
  );
  await exited;

  assert.equal(stopped, true);
  await assert.rejects(() => access(pidPath), /ENOENT/);
  await assert.rejects(() => access(socketPath), /ENOENT/);
});

test("stale PID metadata never terminates a reused process ID", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "synapse-server-test-"));
  const pidPath = join(runtimeRoot, "codex-app-server.pid");
  await writeFile(
    pidPath,
    `${JSON.stringify({ pid: 4242, startMarker: "original-process" })}\n`,
    "utf8",
  );
  const terminated = [];

  const stopped = await stopSharedAppServerIfIdle(
    {
      statePath: join(runtimeRoot, "state.json"),
      runtimeRoot,
      jobId: "job-1",
      dispatchId: "dispatch-1",
    },
    {
      readCurrentState: async () => ({ jobs: [] }),
      isRunning: () => true,
      getProcessStartMarker: async () => "different-process",
      terminate: (pid) => terminated.push(pid),
    },
  );

  assert.equal(stopped, false);
  assert.deepEqual(terminated, []);
  await assert.rejects(() => access(pidPath), /ENOENT/);
});

test("a startup timeout terminates its child and removes stale metadata", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "synapse-server-test-"));
  const pidPath = join(runtimeRoot, "codex-app-server.pid");
  const socketPath = join(runtimeRoot, "codex-app-server.sock");
  let child = null;

  await assert.rejects(
    () =>
      ensureSharedAppServer(
        { runtimeRoot, attempts: 1, delayMs: 0 },
        {
          spawnProcess: () => {
            child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
              stdio: "ignore",
            });
            return child;
          },
          getProcessStartMarker: async () => "test-start",
        },
      ),
    /did not start/,
  );

  assert.ok(child);
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit");
  }
  await assert.rejects(() => access(pidPath), /ENOENT/);
  await assert.rejects(() => access(socketPath), /ENOENT/);
});
