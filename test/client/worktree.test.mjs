import assert from "node:assert/strict";
import test from "node:test";

import { worktreePathForChannel } from "../../src/client/worktree.mjs";

test("distinct channel IDs cannot resolve to the same worktree", () => {
  const first = worktreePathForChannel("/tmp/runtime", "person/a");
  const second = worktreePathForChannel("/tmp/runtime", "person-a");

  assert.notEqual(first, second);
});
