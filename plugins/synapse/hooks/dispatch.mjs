import { execFileSync, spawnSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function gitPath(cwd, argument) {
  const value = execFileSync("git", ["-C", cwd, "rev-parse", argument], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return isAbsolute(value) ? value : resolve(cwd, value);
}

const rawInput = await readStdin();
const input = JSON.parse(rawInput || "{}");
const cwd = input.cwd;

if (!cwd) {
  process.exit(0);
}

let gitDirectory;
let commonDirectory;
try {
  gitDirectory = gitPath(cwd, "--git-dir");
  commonDirectory = gitPath(cwd, "--git-common-dir");
} catch {
  process.exit(0);
}

// Synapse child tasks run in linked worktrees. Only the owner's main checkout
// may dispatch, otherwise a delivered task could recursively consume the inbox.
if (gitDirectory !== commonDirectory) {
  process.exit(0);
}

const pluginRoot =
  process.env.PLUGIN_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

const synapseRoot = resolve(pluginRoot, "../..");
const hookPath = resolve(synapseRoot, "src/client/hook.mjs");
const projectRoot = dirname(commonDirectory);
const child = spawnSync(process.execPath, [hookPath], {
  cwd: projectRoot,
  input: rawInput,
  encoding: "utf8",
  env: {
    ...process.env,
    SYNAPSE_PROJECT_ROOT: projectRoot,
    SYNAPSE_STATE_PATH:
      process.env.SYNAPSE_STATE_PATH ?? resolve(synapseRoot, "state/state.json"),
  },
});

if (child.stdout) {
  process.stdout.write(child.stdout);
}
if (child.status !== 0) {
  process.stderr.write(child.stderr || "Synapse dispatcher hook failed\n");
  process.exit(child.status ?? 1);
}
