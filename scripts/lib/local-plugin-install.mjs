import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

async function bundleFiles(root, prefix = "") {
  const files = [];
  for (const entry of (
    await readdir(join(root, prefix), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await bundleFiles(root, path)));
    else if (entry.isFile())
      files.push([path, await readFile(join(root, path))]);
    else
      throw new Error(`Plugin bundle must contain only regular files: ${path}`);
  }
  return files;
}

export function desktopCodex(env = process.env) {
  if (env.SYNAPSE_CODEX_BIN) return env.SYNAPSE_CODEX_BIN;
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return existsSync(bundled) ? bundled : "codex";
}

export async function runCodex(args) {
  const { stdout } = await execute(desktopCodex(), args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function verifyCachedPlugin(
  build,
  codexRoot = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
) {
  const cached = await bundleFiles(
    join(
      codexRoot,
      "plugins/cache",
      build.marketplaceName,
      "synapse",
      build.version,
    ),
  );
  const expected = await bundleFiles(build.pluginRoot);
  if (
    cached.length !== expected.length ||
    cached.some(
      ([path, bytes], i) =>
        path !== expected[i][0] || !bytes.equals(expected[i][1]),
    )
  )
    throw new Error(
      "Cached Synapse bundle differs from its snapshot; refresh the cachebuster and reinstall",
    );
}

// Development only. Never advertise a mutable worktree under the shared
// synapse@synapse identity: repo discovery can replace that cache on refresh.
// Each checkout gets its own identity and each build is an immutable snapshot.
export async function stageLocalPlugin(
  repositoryRoot,
  { storageRoot = join(homedir(), ".synapse", "plugin-builds") } = {},
) {
  const source = await realpath(repositoryRoot);
  const files = await bundleFiles(join(source, "plugins/synapse"));
  const manifest = JSON.parse(
    files
      .find(([path]) => path === ".codex-plugin/plugin.json")?.[1]
      .toString() ?? "null",
  );
  if (manifest?.name !== "synapse" || typeof manifest.version !== "string")
    throw new Error("Expected a versioned Synapse plugin bundle");
  if (!files.some(([path]) => path === "skills/setup-synapse/SKILL.md"))
    throw new Error(
      "This checkout lacks the plugin-only receiving setup skill",
    );
  const marketplaceName = `synapse-dev-${digest(source).slice(0, 12)}`;
  const hash = createHash("sha256");
  for (const [path, bytes] of files)
    hash.update(JSON.stringify([path, bytes.length])).update(bytes);
  const contentHash = hash.digest("hex");
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const buildRoot = join(
    await realpath(storageRoot),
    marketplaceName,
    contentHash,
  );
  if (buildRoot === source || buildRoot.startsWith(`${source}/`))
    throw new Error("Plugin snapshots must be outside the source checkout");
  const pluginRoot = join(buildRoot, "plugins/synapse");
  const receiptPath = join(buildRoot, "synapse-build.json");
  if (existsSync(buildRoot)) {
    const receipt = await json(receiptPath);
    if (receipt.source !== source || receipt.contentHash !== contentHash)
      throw new Error("Existing snapshot is not owned by this checkout");
    const saved = await bundleFiles(pluginRoot);
    if (
      saved.length !== files.length ||
      saved.some(
        ([path, bytes], i) =>
          path !== files[i][0] || !bytes.equals(files[i][1]),
      )
    )
      throw new Error("Existing immutable plugin snapshot has changed");
  } else {
    await mkdir(dirname(buildRoot), { recursive: true, mode: 0o700 });
    const pendingRoot = await mkdtemp(join(dirname(buildRoot), ".staging-"));
    const pendingPlugin = join(pendingRoot, "plugins/synapse");
    try {
      for (const [path, bytes] of files) {
        await mkdir(dirname(join(pendingPlugin, path)), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(join(pendingPlugin, path), bytes, {
          flag: "wx",
          mode: 0o600,
        });
      }
      await mkdir(join(pendingRoot, ".agents/plugins"), { recursive: true });
      await writeFile(
        join(pendingRoot, ".agents/plugins/marketplace.json"),
        `${JSON.stringify(
          {
            name: marketplaceName,
            interface: { displayName: "Synapse development" },
            plugins: [
              {
                name: "synapse",
                source: { source: "local", path: "./plugins/synapse" },
                policy: {
                  installation: "AVAILABLE",
                  authentication: "ON_INSTALL",
                },
                category: "Productivity",
              },
            ],
          },
          null,
          2,
        )}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(
        join(pendingRoot, "synapse-build.json"),
        `${JSON.stringify({ source, contentHash, version: manifest.version })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await rename(pendingRoot, buildRoot);
    } finally {
      await rm(pendingRoot, { recursive: true, force: true });
    }
  }
  return {
    source,
    marketplaceName,
    pluginId: `synapse@${marketplaceName}`,
    buildRoot,
    pluginRoot,
    contentHash,
    version: manifest.version,
  };
}

export async function installLocalPlugin(
  repositoryRoot,
  {
    storageRoot,
    command = runCodex,
    verify = verifyCachedPlugin,
    replaceRepoPlugin = false,
  } = {},
) {
  const build = await stageLocalPlugin(repositoryRoot, { storageRoot });
  const installed =
    (await command(["plugin", "list", "--json"])).installed ?? [];
  const conflicts = installed.filter(
    (plugin) => plugin.name === "synapse" && plugin.pluginId !== build.pluginId,
  );
  for (const plugin of conflicts) {
    if (
      !replaceRepoPlugin ||
      plugin.pluginId !== "synapse@synapse" ||
      plugin.marketplaceSource?.sourceType !== "local" ||
      resolve(plugin.marketplaceSource.source) !== build.source
    )
      throw new Error(
        `Another Synapse plugin is installed: ${plugin.pluginId}. Use --replace-repo-plugin only to replace this checkout's synapse@synapse installation.`,
      );
  }
  const marketplaces =
    (await command(["plugin", "marketplace", "list", "--json"])).marketplaces ??
    [];
  const previous = marketplaces.find(
    (item) => item.name === build.marketplaceName,
  );
  const previousRoot = previous?.marketplaceSource?.source ?? previous?.root;
  if (previous && previousRoot !== build.buildRoot) {
    const receipt = await json(join(previousRoot, "synapse-build.json"));
    if (
      previous.marketplaceSource?.sourceType !== "local" ||
      receipt.source !== build.source ||
      dirname(previousRoot) !== dirname(build.buildRoot)
    )
      throw new Error(
        "Refusing to replace a development marketplace owned by another source",
      );
    await command([
      "plugin",
      "marketplace",
      "remove",
      build.marketplaceName,
      "--json",
    ]);
  }
  try {
    await command(["plugin", "marketplace", "add", build.buildRoot, "--json"]);
    await command(["plugin", "add", build.pluginId, "--json"]);
    const current = (
      await command(["plugin", "list", "--json"])
    ).installed?.find((item) => item.pluginId === build.pluginId);
    if (
      !current?.installed ||
      !current.enabled ||
      current.version !== build.version ||
      current.source?.path !== build.pluginRoot
    )
      throw new Error(
        "Installed Synapse identity, version, or source does not match the snapshot",
      );
    await verify(build);
  } catch (error) {
    // Leave the prior receiver/plugin intact if the replacement cannot install.
    // Restore the registered snapshot on an update; never edit Codex config/cache.
    if (previousRoot && previousRoot !== build.buildRoot) {
      await command([
        "plugin",
        "marketplace",
        "remove",
        build.marketplaceName,
        "--json",
      ]);
      await command(["plugin", "marketplace", "add", previousRoot, "--json"]);
      await command(["plugin", "add", build.pluginId, "--json"]);
    }
    throw error;
  }
  for (const plugin of conflicts)
    await command(["plugin", "remove", plugin.pluginId, "--json"]);
  return {
    ...build,
    replaced: conflicts.map((item) => item.pluginId),
    receiving: "not_verified",
  };
}
