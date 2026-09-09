import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  desktopCodex,
  installLocalPlugin,
  stageLocalPlugin,
  verifyCachedPlugin,
} from "../../scripts/lib/local-plugin-install.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "synapse-plugin-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "checkout");
  const storageRoot = join(root, "builds");
  async function put(path, value) {
    const target = join(repository, "plugins/synapse", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  await put(
    ".codex-plugin/plugin.json",
    JSON.stringify({ name: "synapse", version: "0.3.0+codex.test" }),
  );
  await put("skills/setup-synapse/SKILL.md", "setup skill");
  await put("hooks/hooks.json", "{}");
  return { repository, storageRoot, put };
}

function fakeCodex(
  build,
  { conflicts = [], failInstall = false, wrongVersion = false, previous } = {},
) {
  const calls = [];
  let installed = [...conflicts];
  const command = async (args) => {
    calls.push(args);
    if (args[1] === "list") return { installed };
    if (args[1] === "marketplace")
      return { marketplaces: previous ? [previous] : [] };
    if (args[1] === "add") {
      if (failInstall) throw new Error("install failed");
      installed.push({
        name: "synapse",
        pluginId: build.pluginId,
        version: wrongVersion ? "old" : build.version,
        installed: true,
        enabled: true,
        source: { path: build.pluginRoot },
      });
    }
    if (args[1] === "remove")
      installed = installed.filter((item) => item.pluginId !== args[2]);
    return {};
  };
  return { command, calls, verify: async () => {} };
}

test("staging isolates identities and snapshots from other checkouts and subsequent edits", async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const first = await stageLocalPlugin(a.repository, a);
  const other = await stageLocalPlugin(b.repository, b);
  assert.notEqual(first.pluginId, "synapse@synapse");
  assert.notEqual(first.pluginId, other.pluginId);
  assert.deepEqual(await stageLocalPlugin(a.repository, a), first);
  await a.put("hooks/hooks.json", '{"new":true}');
  const second = await stageLocalPlugin(a.repository, a);
  assert.equal(second.pluginId, first.pluginId);
  assert.notEqual(second.buildRoot, first.buildRoot);
  assert.equal(
    await readFile(join(first.pluginRoot, "hooks/hooks.json"), "utf8"),
    "{}",
  );
  const catalog = JSON.parse(
    await readFile(join(second.buildRoot, ".agents/plugins/marketplace.json")),
  );
  assert.equal(catalog.name, second.marketplaceName);
  assert.equal(catalog.plugins[0].source.path, "./plugins/synapse");
});

test("staging rejects source symlinks, mutable in-checkout snapshots and modified builds", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    stageLocalPlugin(f.repository, {
      storageRoot: join(f.repository, "builds"),
    }),
    /outside/,
  );
  const build = await stageLocalPlugin(f.repository, f);
  await writeFile(join(build.pluginRoot, "hooks/hooks.json"), "tampered");
  await assert.rejects(
    stageLocalPlugin(f.repository, f),
    /snapshot has changed/,
  );
  await symlink(
    join(f.repository, "plugins/synapse/hooks/hooks.json"),
    join(f.repository, "plugins/synapse/link"),
  );
  await assert.rejects(stageLocalPlugin(f.repository, f), /regular files/);
});

test("staging rejects old bundles without receiving setup", async (t) => {
  const f = await fixture(t);
  await rm(join(f.repository, "plugins/synapse/skills"), { recursive: true });
  await assert.rejects(stageLocalPlugin(f.repository, f), /lacks/);
});

test("install verifies the snapshot before retiring only the explicitly selected legacy plugin", async (t) => {
  const f = await fixture(t);
  const build = await stageLocalPlugin(f.repository, f);
  const conflict = {
    name: "synapse",
    pluginId: "synapse@synapse",
    marketplaceSource: { sourceType: "local", source: build.source },
  };
  const fake = fakeCodex(build, { conflicts: [conflict] });
  const result = await installLocalPlugin(f.repository, {
    ...f,
    ...fake,
    replaceRepoPlugin: true,
  });
  assert.equal(result.receiving, "not_verified");
  assert.deepEqual(result.replaced, [conflict.pluginId]);
  assert.deepEqual(fake.calls.at(-1), [
    "plugin",
    "remove",
    "synapse@synapse",
    "--json",
  ]);
  assert.equal(
    fake.calls.some((args) => /trust|receiver|login/.test(args.join(" "))),
    false,
  );
});

test("conflicting plugins are preserved without explicit replacement or with a different source", async (t) => {
  const f = await fixture(t);
  const build = await stageLocalPlugin(f.repository, f);
  for (const [replaceRepoPlugin, source] of [
    [false, build.source],
    [true, "/different-checkout"],
  ]) {
    const fake = fakeCodex(build, {
      conflicts: [
        {
          name: "synapse",
          pluginId: "synapse@synapse",
          marketplaceSource: { sourceType: "local", source },
        },
      ],
    });
    await assert.rejects(
      installLocalPlugin(f.repository, { ...f, ...fake, replaceRepoPlugin }),
      /Another Synapse/,
    );
    assert.deepEqual(fake.calls, [["plugin", "list", "--json"]]);
  }
});

test("failed installation and mismatched verification never remove the previous plugin", async (t) => {
  const f = await fixture(t);
  const build = await stageLocalPlugin(f.repository, f);
  for (const options of [{ failInstall: true }, { wrongVersion: true }]) {
    const fake = fakeCodex(build, options);
    await assert.rejects(installLocalPlugin(f.repository, { ...f, ...fake }));
    assert.equal(
      fake.calls.some((args) => args[1] === "remove"),
      false,
    );
  }
});

test("updating registers the new immutable snapshot under the same development identity", async (t) => {
  const f = await fixture(t);
  const first = await stageLocalPlugin(f.repository, f);
  await f.put("hooks/hooks.json", '{"next":true}');
  const next = await stageLocalPlugin(f.repository, f);
  const fake = fakeCodex(next, {
    previous: {
      name: first.marketplaceName,
      marketplaceSource: { sourceType: "local", source: first.buildRoot },
    },
  });
  await installLocalPlugin(f.repository, { ...f, ...fake });
  assert.deepEqual(fake.calls[2], [
    "plugin",
    "marketplace",
    "remove",
    first.marketplaceName,
    "--json",
  ]);
  assert.deepEqual(fake.calls[3], [
    "plugin",
    "marketplace",
    "add",
    next.buildRoot,
    "--json",
  ]);
  assert.equal(
    await readFile(join(first.pluginRoot, "hooks/hooks.json"), "utf8"),
    "{}",
  );
});

test("desktop runtime selection supports an explicit executable override", () => {
  assert.equal(
    desktopCodex({ SYNAPSE_CODEX_BIN: "/custom/codex" }),
    "/custom/codex",
  );
});

test("a failed update restores the previous registered snapshot", async (t) => {
  const f = await fixture(t);
  const first = await stageLocalPlugin(f.repository, f);
  await f.put("hooks/hooks.json", '{"next":true}');
  const next = await stageLocalPlugin(f.repository, f);
  const fake = fakeCodex(next, {
    previous: {
      name: first.marketplaceName,
      marketplaceSource: { sourceType: "local", source: first.buildRoot },
    },
  });
  let installs = 0;
  await assert.rejects(
    installLocalPlugin(f.repository, {
      ...f,
      ...fake,
      command: async (args) => {
        if (args[1] === "add" && ++installs === 1)
          throw new Error("transient install failure");
        return fake.command(args);
      },
    }),
    /transient install failure/,
  );
  assert.deepEqual(fake.calls.slice(-3), [
    ["plugin", "marketplace", "remove", first.marketplaceName, "--json"],
    ["plugin", "marketplace", "add", first.buildRoot, "--json"],
    ["plugin", "add", first.pluginId, "--json"],
  ]);
});

test("an unknown marketplace owner is never replaced", async (t) => {
  const f = await fixture(t);
  const first = await stageLocalPlugin(f.repository, f);
  await f.put("hooks/hooks.json", '{"next":true}');
  const next = await stageLocalPlugin(f.repository, f);
  await writeFile(
    join(first.buildRoot, "synapse-build.json"),
    JSON.stringify({ source: "/another-owner" }),
  );
  const fake = fakeCodex(next, {
    previous: {
      name: first.marketplaceName,
      marketplaceSource: { sourceType: "local", source: first.buildRoot },
    },
  });
  await assert.rejects(
    installLocalPlugin(f.repository, { ...f, ...fake }),
    /owned by another source/,
  );
  assert.equal(
    fake.calls.some((args) => args.includes("remove")),
    false,
  );
});

test("verification compares actual cached bytes, not only the reported version", async (t) => {
  const f = await fixture(t);
  const build = await stageLocalPlugin(f.repository, f);
  const codexRoot = join(f.storageRoot, "codex-fixture");
  const cache = join(
    codexRoot,
    "plugins/cache",
    build.marketplaceName,
    "synapse",
    build.version,
  );
  await cp(build.pluginRoot, cache, { recursive: true });
  await verifyCachedPlugin(build, codexRoot);
  await writeFile(join(cache, "hooks/hooks.json"), "other checkout");
  await assert.rejects(verifyCachedPlugin(build, codexRoot), /differs/);
});

test("failed cache verification keeps the legacy install", async (t) => {
  const f = await fixture(t);
  const build = await stageLocalPlugin(f.repository, f);
  const fake = fakeCodex(build, {
    conflicts: [
      {
        name: "synapse",
        pluginId: "synapse@synapse",
        marketplaceSource: { sourceType: "local", source: build.source },
      },
    ],
  });
  await assert.rejects(
    installLocalPlugin(f.repository, {
      ...f,
      ...fake,
      replaceRepoPlugin: true,
      verify: async () => {
        throw new Error("wrong cache");
      },
    }),
    /wrong cache/,
  );
  assert.equal(
    fake.calls.some((args) => args[1] === "remove"),
    false,
  );
});
