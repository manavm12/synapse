import assert from "node:assert/strict";
import test from "node:test";

import { resolveCodexBinary, runtimeRootForProject } from "../../src/client/config.mjs";

test("an explicit Codex binary overrides local installation detection", () => {
  const binary = resolveCodexBinary({
    env: { CODEX_BINARY: "/custom/codex" },
    platform: "darwin",
    pathExists: () => true,
  });

  assert.equal(binary, "/custom/codex");
});

test("macOS uses the Codex desktop binary when it is installed", () => {
  const binary = resolveCodexBinary({
    env: {},
    platform: "darwin",
    pathExists: (path) => path === "/Applications/ChatGPT.app/Contents/Resources/codex",
  });

  assert.equal(binary, "/Applications/ChatGPT.app/Contents/Resources/codex");
});

test("runtime roots are isolated by project", () => {
  const first = runtimeRootForProject("/projects/first", "/tmp");
  const second = runtimeRootForProject("/projects/second", "/tmp");

  assert.notEqual(first, second);
});
