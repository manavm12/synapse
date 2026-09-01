import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MACOS_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";
const MANAGED_CODEX_BINARY = join(
  homedir(),
  ".codex",
  "packages",
  "standalone",
  "current",
  "codex",
);

export function resolveCodexBinary({
  env = process.env,
  platform = process.platform,
  pathExists = existsSync,
} = {}) {
  if (env.CODEX_BINARY) {
    return env.CODEX_BINARY;
  }
  if (pathExists(MANAGED_CODEX_BINARY)) {
    return MANAGED_CODEX_BINARY;
  }
  if (platform === "darwin" && pathExists(MACOS_CODEX_BINARY)) {
    return MACOS_CODEX_BINARY;
  }
  return "codex";
}

export function resolveSynapseHome(env = process.env) {
  return resolve(env.SYNAPSE_HOME ?? join(homedir(), ".synapse"));
}

export function resolveRelayUrl(env = process.env) {
  return env.SYNAPSE_RELAY_URL ?? "http://127.0.0.1:8787";
}

export function relayWebSocketUrl(relayUrl) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/host";
  url.search = "";
  return url.toString();
}

export function createPaths({ env = process.env, synapseHome = resolveSynapseHome(env) } = {}) {
  return {
    synapseHome,
    relayDatabase: resolve(env.SYNAPSE_RELAY_DB ?? join(synapseHome, "relay.sqlite")),
    hostDatabase: resolve(env.SYNAPSE_HOST_DB ?? join(synapseHome, "host.sqlite")),
    worktreeRoot: resolve(
      env.SYNAPSE_WORKTREE_ROOT ?? join(synapseHome, "worktrees"),
    ),
    appServerSocket: resolve(
      env.SYNAPSE_APP_SERVER_SOCKET ??
        join(homedir(), ".codex", "app-server-control", "app-server-control.sock"),
    ),
  };
}

export const CODEX_BINARY = resolveCodexBinary();
export const RELAY_URL = resolveRelayUrl();
export const PATHS = createPaths();
