import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SAFE_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

export async function readHookInput(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error("Hook input is too large");
    chunks.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (
    !input ||
    Array.isArray(input) ||
    !SAFE_ID.test(input.session_id ?? "") ||
    typeof input.cwd !== "string" ||
    !isAbsolute(input.cwd) ||
    input.cwd.length > 4096 ||
    (input.turn_id != null && !SAFE_ID.test(input.turn_id))
  )
    return null;
  return input;
}

export function primaryCheckout(cwd) {
  const output = execFileSync(
    "git",
    ["-C", cwd, "worktree", "list", "--porcelain"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    },
  );
  const root = output.match(/^worktree (.+)$/m)?.[1];
  if (!root || !isAbsolute(root)) throw new Error("No primary checkout found");
  return realpathSync(root);
}

export function sessionRegistration(input, env = process.env) {
  let projectRoot;
  try {
    projectRoot = primaryCheckout(input.cwd);
  } catch {
    projectRoot = resolve(input.cwd);
  }
  const bundledCodex =
    env.CODEX_MCP_NODE_PATH &&
    join(dirname(dirname(dirname(env.CODEX_MCP_NODE_PATH))), "codex");
  return {
    sessionId: input.session_id,
    event: input.hook_event_name,
    projectRoot,
    cwd: resolve(input.cwd),
    transcriptPath:
      typeof input.transcript_path === "string" &&
      isAbsolute(input.transcript_path)
        ? input.transcript_path
        : null,
    pipePath: env.CODEX_APP_TOOLS_PIPE_PATH || null,
    nodePath: env.CODEX_MCP_NODE_PATH || null,
    codexPath:
      env.SYNAPSE_CODEX_PATH ||
      (bundledCodex && existsSync(bundledCodex) ? bundledCodex : null),
  };
}
