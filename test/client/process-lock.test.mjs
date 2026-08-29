import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireProcessLock } from "../../src/client/process-lock.mjs";

test("a lock owner detects replacement before committing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-lock-test-"));
  const path = join(directory, "state.lock");
  const release = await acquireProcessLock(path);
  await rm(path, { recursive: true });
  await mkdir(path);
  await writeFile(join(path, "owner-999999-replacement"), "", "utf8");

  await assert.rejects(() => release.assertOwned(), /Lost ownership/);
  await release();
});
