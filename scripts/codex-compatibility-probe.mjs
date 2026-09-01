import { realpath } from "node:fs/promises";

import { AppServerClient } from "../src/client/app-server-client.mjs";
import { CODEX_BINARY } from "../src/client/config.mjs";

const projectRoot = await realpath(process.cwd());
const client = new AppServerClient({
  codexBinary: CODEX_BINARY,
  codexArguments: ["app-server", "--stdio"],
  timeoutMs: 30_000,
});

let threadId = null;
let output;
try {
  await client.start();
  const profiles = await client.request("permissionProfile/list", {
    cwd: projectRoot,
    limit: 100,
  });
  const workspace = profiles.data.find(
    (profile) => profile.id === ":workspace" && profile.allowed,
  );
  if (!workspace) {
    throw new Error("The :workspace permission profile is unavailable");
  }

  const projectPage = await client.request("project/list", { limit: 100 });
  let project = projectPage.data.find((candidate) =>
    candidate.roots.some((root) => root.path === projectRoot),
  );
  if (!project) {
    ({ project } = await client.request("project/create", {
      name: "synapse",
      roots: [{ path: projectRoot }],
      metadata: { createdBy: "synapse-compatibility-probe" },
      idempotencyKey: `synapse-compatibility:${projectRoot}`,
    }));
  }

  const started = await client.request("thread/start", {
    cwd: projectRoot,
    projectId: project.id,
    permissions: ":workspace",
    serviceName: "Synapse Compatibility Probe",
    threadSource: "synapse-probe",
  });
  threadId = started.thread.id;
  await client.request("thread/name/set", {
    threadId,
    name: "Synapse Compatibility Probe",
  });
  let resolveStarted;
  const startedPromise = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const onStarted = (params) => {
    if (params.threadId === threadId) {
      resolveStarted(params);
    }
  };
  client.on("turn/started", onStarted);
  const added = await client.request("thread/queue/add", {
    threadId,
    clientUserMessageId: `probe-${Date.now()}`,
    input: [{ type: "text", text: "Compatibility probe only; do not run." }],
  });
  const queued = await client.request("thread/queue/list", { threadId, limit: 100 });
  const remainedQueued = queued.data.some(
    (item) => item.id === added.queuedSubmission.id,
  );
  let queueBehavior;
  if (remainedQueued) {
    client.off("turn/started", onStarted);
    await client.request("thread/queue/delete", {
      threadId,
      queuedSubmissionId: added.queuedSubmission.id,
    });
    queueBehavior = "queued";
  } else {
    const started = await startedPromise;
    client.off("turn/started", onStarted);
    const completedPromise = client.waitFor(
      "turn/completed",
      (params) => params.threadId === threadId && params.turn.id === started.turn.id,
    );
    await client.request("turn/interrupt", {
      threadId,
      turnId: started.turn.id,
    });
    await completedPromise;
    queueBehavior = "auto-promoted";
  }
  output = {
    codexBinary: CODEX_BINARY,
    projectId: project.id,
    permissionProfile: workspace.id,
    projectApi: "ok",
    nativeQueueApi: "ok",
    idleQueueBehavior: queueBehavior,
  };
} finally {
  if (threadId) {
    try {
      await client.request("thread/delete", { threadId });
    } catch {
      // Preserve the primary probe failure if cleanup also fails.
    }
  }
  await client.close();
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
