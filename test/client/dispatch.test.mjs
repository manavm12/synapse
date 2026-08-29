import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dispatchInbox } from "../../src/client/dispatch.mjs";
import { addJob } from "../../src/client/store.mjs";

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
