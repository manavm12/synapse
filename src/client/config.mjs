import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const MACOS_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";

export function resolveCodexBinary({
  env = process.env,
  platform = process.platform,
  pathExists = existsSync,
} = {}) {
  if (env.CODEX_BINARY) {
    return env.CODEX_BINARY;
  }
  if (platform === "darwin" && pathExists(MACOS_CODEX_BINARY)) {
    return MACOS_CODEX_BINARY;
  }
  return "codex";
}

export function runtimeRootForProject(
  projectRoot,
  temporaryRoot = process.platform === "darwin" ? "/tmp" : tmpdir(),
) {
  const projectHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  return join(temporaryRoot, `synapse-client-${projectHash}`);
}

export const PROJECT_ROOT = resolve(SOURCE_DIRECTORY, "../..");
export const STATE_PATH =
  process.env.SYNAPSE_STATE_PATH ?? join(PROJECT_ROOT, "state", "state.json");
export const RUNTIME_ROOT =
  process.env.SYNAPSE_RUNTIME_ROOT ?? runtimeRootForProject(PROJECT_ROOT);
export const CODEX_BINARY = resolveCodexBinary();
export const APP_SERVER_SOCKET = join(RUNTIME_ROOT, "codex-app-server.sock");
export const WORKER_PATH = join(SOURCE_DIRECTORY, "worker.mjs");
export const MCP_SERVER_PATH = join(SOURCE_DIRECTORY, "mcp-server.mjs");
