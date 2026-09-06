import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("the marketplace and plugin manifests reference repository content", async () => {
  const packageManifest = await readJson(join(repositoryRoot, "package.json"));
  const marketplace = await readJson(
    join(repositoryRoot, ".agents/plugins/marketplace.json"),
  );
  assert.equal(marketplace.plugins.length, 1);

  const listing = marketplace.plugins[0];
  const pluginRoot = resolve(repositoryRoot, listing.source.path);
  const pluginManifest = await readJson(
    join(pluginRoot, ".codex-plugin/plugin.json"),
  );
  const hooksManifest = await readJson(join(pluginRoot, "hooks/hooks.json"));

  assert.equal(listing.name, pluginManifest.name);
  assert.equal(pluginManifest.version.split("+")[0], packageManifest.version);
  assert.equal(pluginManifest.skills, undefined);
  assert.equal(
    hooksManifest.hooks.SessionStart.some(
      (entry) => entry.matcher === "^startup$",
    ),
    false,
  );

  const hook = hooksManifest.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hook.type, "command");
  assert.equal(hook.command, `node \${PLUGIN_ROOT}/hooks/dispatch.mjs`);
  assert.equal(hook.async, true);
  await access(join(pluginRoot, "hooks/dispatch.mjs"));
  await access(join(pluginRoot, "lib/native-router.mjs"));
  await access(join(pluginRoot, "lib/app-server-client.mjs"));
});
