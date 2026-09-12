import assert from "node:assert/strict";
import test from "node:test";
import { openExternalUrl } from "../../plugins/synapse/lib/open-url.mjs";

test("browser opener uses the native command on macOS, Windows, and Linux", async () => {
  const calls = [];
  const runCommand = async (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
  };
  await openExternalUrl("https://synapse.example/approve", {
    platform: "darwin",
    runCommand,
  });
  await openExternalUrl("https://synapse.example/approve", {
    platform: "win32",
    runCommand,
  });
  await openExternalUrl("https://synapse.example/approve", {
    platform: "linux",
    runCommand,
  });
  assert.equal(calls[0].command, "/usr/bin/open");
  assert.equal(calls[1].command, "powershell.exe");
  assert.match(calls[1].arguments_.join(" "), /Start-Process/);
  assert.equal(calls[2].command, "xdg-open");
  for (const call of calls)
    assert.equal(call.arguments_.at(-1), "https://synapse.example/approve");
});

test("browser opener rejects unsafe protocols and unsupported platforms", async () => {
  await assert.rejects(
    () => openExternalUrl("file:///secret", { platform: "linux" }),
    /HTTP or HTTPS/,
  );
  await assert.rejects(
    () => openExternalUrl("https://synapse.example", { platform: "aix" }),
    /not supported/,
  );
});
