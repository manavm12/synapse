import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = resolve(
  repositoryRoot,
  "plugins/synapse/server/memory-mcp.mjs",
);
const outputPath = resolve(
  repositoryRoot,
  "plugins/synapse/server/memory-mcp.bundle.mjs",
);
const check = process.argv.includes("--check");

const options = {
  entryPoints: [entryPoint],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  legalComments: "none",
};

const result = await build({ ...options, write: false });
const bundledSource = Buffer.from(result.outputFiles[0].contents)
  .toString("utf8")
  .replace(/[ \t]+$/gm, "");

if (check) {
  const actual = await readFile(outputPath, "utf8");
  if (actual !== bundledSource) {
    throw new Error("Plugin MCP bundle is stale; run npm run build:plugin");
  }
  process.stdout.write("Plugin MCP bundle is current\n");
} else {
  await writeFile(outputPath, bundledSource, "utf8");
  process.stdout.write(`Built ${outputPath}\n`);
}
