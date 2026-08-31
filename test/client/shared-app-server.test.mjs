import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import {
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
  await writeFile(pidPath, `${child.pid}\n`, "utf8");

  const stopped = await stopSharedAppServerIfIdle(
    {
      statePath: join(runtimeRoot, "state.json"),
      runtimeRoot,
      jobId: "job-1",
      dispatchId: "dispatch-1",
    },
    { readCurrentState: async () => ({ jobs: [] }) },
  );
  await exited;

  assert.equal(stopped, true);
  await assert.rejects(() => access(pidPath), /ENOENT/);
  await assert.rejects(() => access(socketPath), /ENOENT/);
});
