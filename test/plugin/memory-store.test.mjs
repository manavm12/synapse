import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  checkpointMemory,
  createMemoryPaths,
  findRegisteredProject,
  markCompactionDue,
  saveSessionMemory,
} from "../../plugins/synapse/server/memory-store.mjs";
import {
  createMemoryFixture,
  readMemorySession,
  registerProject,
  VALID_MEMORY_MARKDOWN,
} from "./_helpers.mjs";

test("capture is due on the third distinct turn and Stop continuation cannot loop", async (t) => {
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
    {
      sessionId: "session-1",
      turnId: "turn-3",
      cwd: fixture.projectRoot,
    },
    { env: fixture.env },
  );
  assert.equal(due.due, true);
  assert.equal(due.decision, "block");
  assert.match(due.reason, /save_session_memory/);

  const repeatedStop = checkpointMemory(
    {
      sessionId: "session-1",
      turnId: "turn-3",
      cwd: fixture.projectRoot,
      stopHookActive: true,
    },
    { env: fixture.env },
  );
  assert.equal(repeatedStop.duplicate, true);
  assert.equal(repeatedStop.due, true);
  assert.equal("decision" in repeatedStop, false);
  assert.equal(repeatedStop.unsavedTurns, 3);
});

test("saving updates one document, clears the checkpoint, and starts a new interval", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  for (let turn = 1; turn <= 3; turn += 1) {
    checkpointMemory(
      {
        sessionId: "session-save",
        turnId: `turn-${turn}`,
        cwd: fixture.linkedWorktree,
      },
      { env: fixture.env },
    );
  }

  const first = await saveSessionMemory(
    {
      sessionId: "session-save",
      title: "First title",
      summary: "First summary",
      markdown: VALID_MEMORY_MARKDOWN,
    },
    { env: fixture.env },
  );
  assert.equal(first.revision, 1);
  assert.equal(first.projectAlias, "fixture");
  assert.match(await readFile(first.path, "utf8"), /revision: 1/);

  const duplicateSavedTurn = checkpointMemory(
    {
      sessionId: "session-save",
      turnId: "turn-3",
      cwd: fixture.linkedWorktree,
    },
    { env: fixture.env },
  );
  assert.equal(duplicateSavedTurn.unsavedTurns, 0);
  assert.equal(duplicateSavedTurn.due, false);

  for (let turn = 4; turn <= 6; turn += 1) {
    const result = checkpointMemory(
      {
        sessionId: "session-save",
        turnId: `turn-${turn}`,
        cwd: fixture.projectRoot,
      },
      { env: fixture.env },
    );
    assert.equal(result.due, turn === 6);
  }

  const second = await saveSessionMemory(
    {
      sessionId: "session-save",
      title: "Updated title",
      summary: "Updated summary",
      markdown: VALID_MEMORY_MARKDOWN.replace("A concise summary.", "Updated body."),
    },
    { env: fixture.env },
  );
  assert.equal(second.path, first.path);
  assert.equal(second.revision, 2);
  const document = await readFile(second.path, "utf8");
  assert.match(document, /revision: 2/);
  assert.match(document, /Updated body/);
  assert.doesNotMatch(document, /revision: 1/);
  assert.deepEqual(await readdir(join(fixture.synapseHome, "memory", "fixture")), [
    "session-save.md",
  ]);
  assert.equal(
    (await stat(join(fixture.synapseHome, "memory.sqlite"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await stat(join(fixture.synapseHome, "memory"))).mode & 0o777,
    0o700,
  );
  assert.equal((await stat(join(fixture.synapseHome, "memory", "fixture"))).mode & 0o777, 0o700);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
});

test("concurrent saves to one session serialize revisions without losing an update", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  checkpointMemory(
    { sessionId: "same-session", turnId: "turn-1", cwd: fixture.projectRoot },
    { env: fixture.env },
  );
  const saves = await Promise.all([
    saveSessionMemory(
      {
        sessionId: "same-session",
        title: "Concurrent A",
        summary: "First concurrent save.",
        markdown: VALID_MEMORY_MARKDOWN.replace("A concise summary.", "Save A."),
      },
      { env: fixture.env },
    ),
    saveSessionMemory(
      {
        sessionId: "same-session",
        title: "Concurrent B",
        summary: "Second concurrent save.",
        markdown: VALID_MEMORY_MARKDOWN.replace("A concise summary.", "Save B."),
      },
      { env: fixture.env },
    ),
  ]);

  assert.deepEqual(
    saves.map((save) => save.revision).sort((left, right) => left - right),
    [1, 2],
  );
  const document = await readFile(saves[0].path, "utf8");
  assert.match(document, /revision: 2/);
  assert.equal(/Save A\./.test(document) || /Save B\./.test(document), true);
  const session = readMemorySession(
    join(fixture.synapseHome, "memory.sqlite"),
    "same-session",
  );
  assert.equal(session.revision, 2);
});

test("compaction marks a registered session due and linked worktrees resolve to the owner project", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  assert.deepEqual(
    findRegisteredProject(fixture.linkedWorktree, createMemoryPaths(fixture.env)),
    { alias: "fixture", root: await realpath(fixture.projectRoot) },
  );
  const result = markCompactionDue(
    { sessionId: "compact-session", cwd: fixture.linkedWorktree },
    { env: fixture.env },
  );
  assert.equal(result.due, true);
  assert.match(result.prompt, /compaction boundary/);
  assert.match(result.prompt, /compact-session/);
  const session = readMemorySession(
    join(fixture.synapseHome, "memory.sqlite"),
    "compact-session",
  );
  assert.equal(session.due_reason, "compaction boundary");
});

test("unregistered projects fail open without creating memory state", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const other = join(fixture.directory, "unregistered");
  await mkdir(other);
  await new Promise((resolvePromise, reject) => {
    import("node:child_process").then(({ execFile }) => {
      execFile("git", ["init", "-q"], { cwd: other }, (error) =>
        error ? reject(error) : resolvePromise(),
      );
    });
  });

  const result = checkpointMemory(
    { sessionId: "ignored", turnId: "turn-1", cwd: other },
    { env: fixture.env },
  );
  assert.deepEqual(result, { registered: false, due: false });
});

test("sessions cannot cross projects and invalid memory input is rejected", async (t) => {
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
  assert.throws(
    () =>
      checkpointMemory(
        { sessionId: "../escape", turnId: "turn-1", cwd: fixture.projectRoot },
        { env: fixture.env },
      ),
    /unsupported characters/,
  );
  await assert.rejects(
    saveSessionMemory(
      {
        sessionId: "bound-session",
        title: "Bad memory",
        summary: "Missing sections",
        markdown: "## Summary\nOnly one section.",
      },
      { env: fixture.env },
    ),
    /missing required headings/,
  );
  await assert.rejects(
    saveSessionMemory(
      {
        sessionId: "unknown-session",
        title: "Unknown",
        summary: "Unknown",
        markdown: VALID_MEMORY_MARKDOWN,
      },
      { env: fixture.env },
    ),
    /Unknown memory session/,
  );
});

test("concurrent sessions retain independent checkpoints", async (t) => {
  const fixture = await createMemoryFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  for (let turn = 1; turn <= 3; turn += 1) {
    const first = checkpointMemory(
      { sessionId: "session-a", turnId: `a-${turn}`, cwd: fixture.projectRoot },
      { env: fixture.env },
    );
    const second = checkpointMemory(
      { sessionId: "session-b", turnId: `b-${turn}`, cwd: fixture.projectRoot },
      { env: fixture.env },
    );
    assert.equal(first.due, turn === 3);
    assert.equal(second.due, turn === 3);
  }
});
