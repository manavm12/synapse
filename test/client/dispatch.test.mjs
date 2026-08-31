import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dispatchInbox } from "../../src/client/dispatch.mjs";
import {
  addJob,
  readState,
  reserveNextJob,
  setJobTurn,
  setJobWorker,
} from "../../src/client/store.mjs";

test("repeated inbox checks spawn one worker and return metadata only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-dispatch-test-"));
  const path = join(directory, "state.json");
  const secret = "DO-NOT-ENTER-PARENT-CONTEXT";
  const spawned = [];
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: secret,
  });

  const first = await dispatchInbox({
    statePath: path,
    spawnWorker: async (metadata) => spawned.push(metadata),
  });
  const second = await dispatchInbox({
    statePath: path,
    spawnWorker: async (metadata) => spawned.push(metadata),
  });

  assert.equal(spawned.length, 1);
  assert.equal(second, null);
  assert.equal(JSON.stringify(first).includes(secret), false);
});

test("a dead worker's Codex turn is stopped before replacement dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-dispatch-test-"));
  const path = join(directory, "state.json");
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  const first = await reserveNextJob(path, {
    createDispatchId: () => "dispatch-1",
  });
  await setJobWorker(path, "job-1", first.dispatchId, 2147483647);
  await setJobTurn(path, "job-1", first.dispatchId, {
    threadId: "thread-1",
    turnId: "turn-1",
  });

  const events = [];
  const replacement = await dispatchInbox({
    statePath: path,
    recoverWorker: async (metadata) => {
      events.push(`interrupt:${metadata.turnId}`);
    },
    spawnWorker: async (metadata) => {
      events.push(`spawn:${metadata.jobId}`);
    },
  });

  assert.deepEqual(events, ["interrupt:turn-1", "spawn:job-1"]);
  assert.equal(replacement.jobId, "job-1");
  assert.notEqual(replacement.dispatchId, "dispatch-1");
});

test("a failed turn interruption blocks redispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-dispatch-test-"));
  const path = join(directory, "state.json");
  await addJob(path, {
    id: "job-1",
    channelId: "channel-1",
    sender: "person-a",
    task: "task",
  });
  const first = await reserveNextJob(path);
  await setJobWorker(path, "job-1", first.dispatchId, 2147483647);
  await setJobTurn(path, "job-1", first.dispatchId, {
    threadId: "thread-1",
    turnId: "turn-1",
  });

  const spawned = [];
  const replacement = await dispatchInbox({
    statePath: path,
    recoverWorker: async () => {
      throw new Error("App Server unavailable");
    },
    spawnWorker: async (metadata) => spawned.push(metadata),
  });

  assert.equal(replacement, null);
  assert.equal(spawned.length, 0);
  const state = await readState(path);
  assert.equal(state.jobs[0].status, "blocked");
  assert.match(state.jobs[0].error, /App Server unavailable/);
});
