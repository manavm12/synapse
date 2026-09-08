import assert from "node:assert/strict";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  CHECKPOINT_INTERVAL,
  checkpointMemory,
  createCompactionCheckpoint,
  createMemoryPaths,
  findRegisteredProject,
  getPendingMemoryPrompt,
} from "../../plugins/synapse/server/memory-store.mjs";
import {
  createMemoryFixture,
  readCheckpointSession,
  registerProject,
} from "./_helpers.mjs";

test("production checkpoints default to ten turns", () => {
  assert.equal(CHECKPOINT_INTERVAL, 10);
});

test("capture is due on the configured distinct turn and private prompt clears it", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  for (let turn = 1; turn < 3; turn += 1) {
    const result = checkpointMemory(
      {
        sessionId: "session-1",
        turnId: `turn-${turn}`,
        cwd: fixture.projectRoot,
      },
      { env: fixture.env },
    );
    assert.equal(result.due, false);
    assert.equal(result.remainingTurns, 3 - turn);
  }

  const due = checkpointMemory(
    { sessionId: "session-1", turnId: "turn-3", cwd: fixture.projectRoot },
    {
      env: fixture.env,
      createCaptureId: () => "11111111-1111-4111-8111-111111111111",
    },
  );
  assert.equal(due.due, true);
  assert.equal(due.captureId, "11111111-1111-4111-8111-111111111111");
  assert.equal("decision" in due, false);
  assert.equal(due.reason, "turn_checkpoint");

  const pending = getPendingMemoryPrompt(
    {
      sessionId: "session-1",
      cwd: fixture.projectRoot,
    },
    { env: fixture.env },
  );
  assert.equal(pending.due, true);
  assert.equal(pending.captureId, "11111111-1111-4111-8111-111111111111");
  assert.match(pending.prompt, /project_alias=fixture/);
  assert.match(pending.prompt, /capture_reason=turn_checkpoint/);
  assert.doesNotMatch(pending.prompt, new RegExp(fixture.projectRoot));
  const session = readCheckpointSession(
    join(fixture.synapseHome, "checkpoints.sqlite"),
    "session-1",
  );
  assert.equal(session.due_capture_id, null);
});

test("consumed private prompts do not count toward the next interval", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  for (let turn = 1; turn <= 3; turn += 1) {
    checkpointMemory(
      {
        sessionId: "session-next",
        turnId: `turn-${turn}`,
        cwd: fixture.projectRoot,
      },
      { env: fixture.env },
    );
  }
  getPendingMemoryPrompt(
    {
      sessionId: "session-next",
      cwd: fixture.projectRoot,
    },
    { env: fixture.env },
  );
  for (let turn = 4; turn <= 6; turn += 1) {
    const result = checkpointMemory(
      {
        sessionId: "session-next",
        turnId: `turn-${turn}`,
        cwd: fixture.projectRoot,
      },
      { env: fixture.env },
    );
    assert.equal(result.due, turn === 6);
  }
  assert.equal(
    (await stat(join(fixture.synapseHome, "checkpoints.sqlite"))).mode & 0o777,
    0o600,
  );
});

test("compaction emits a cloud save without persisting a local due record", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  assert.deepEqual(
    findRegisteredProject(
      fixture.linkedWorktree,
      createMemoryPaths(fixture.env),
    ),
    { alias: "fixture", root: await realpath(fixture.projectRoot) },
  );
  const result = createCompactionCheckpoint(
    { sessionId: "compact-session", cwd: fixture.linkedWorktree },
    {
      env: fixture.env,
      createCaptureId: () => "22222222-2222-4222-8222-222222222222",
    },
  );
  assert.equal(result.captureId, "22222222-2222-4222-8222-222222222222");
  assert.match(result.prompt, /capture_reason=compaction/);
  await assert.rejects(
    access(join(fixture.synapseHome, "checkpoints.sqlite")),
    /ENOENT/,
  );
});

test("unregistered projects fail open without creating checkpoint state", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const other = join(fixture.directory, "unregistered");
  await mkdir(other);
  const result = checkpointMemory(
    { sessionId: "ignored", turnId: "turn-1", cwd: other },
    { env: fixture.env },
  );
  assert.deepEqual(result, { registered: false, due: false });
});

test("one session cannot cross registered projects", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const other = join(fixture.directory, "other-project");
  await mkdir(other);
  const { execFile } = await import("node:child_process");
  await new Promise((resolvePromise, reject) =>
    execFile("git", ["init", "-q"], { cwd: other }, (error) =>
      error ? reject(error) : resolvePromise(),
    ),
  );
  registerProject(fixture.hostDatabase, "other", other);
  checkpointMemory(
    { sessionId: "bound-session", turnId: "turn-1", cwd: fixture.projectRoot },
    { env: fixture.env },
  );
  assert.throws(
    () =>
      checkpointMemory(
        { sessionId: "bound-session", turnId: "turn-2", cwd: other },
        { env: fixture.env },
      ),
    /already bound to another project/,
  );
});
