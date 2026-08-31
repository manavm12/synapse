import { APP_SERVER_SOCKET } from "./config.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import { ensureSharedAppServer } from "./shared-app-server.mjs";

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findTurn(response, turnId) {
  return response?.thread?.turns?.find((turn) => turn.id === turnId) ?? null;
}

export async function interruptTurnForRecovery(
  { threadId, turnId },
  {
    ensureServer = ensureSharedAppServer,
    createClient = () => new AppServerClient({ socketPath: APP_SERVER_SOCKET, timeoutMs: 8_000 }),
    attempts = 100,
    delayMs = 50,
  } = {},
) {
  await ensureServer();
  const client = createClient();
  try {
    await client.start();
    let turn = findTurn(
      await client.request("thread/read", { threadId, includeTurns: true }),
      turnId,
    );
    if (!turn) {
      throw new Error(`Codex turn ${turnId} was not found in thread ${threadId}`);
    }
    if (TERMINAL_TURN_STATUSES.has(turn.status)) {
      return turn.status;
    }

    await client.request("turn/interrupt", { threadId, turnId });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      turn = findTurn(
        await client.request("thread/read", { threadId, includeTurns: true }),
        turnId,
      );
      if (turn && TERMINAL_TURN_STATUSES.has(turn.status)) {
        return turn.status;
      }
      await sleep(delayMs);
    }
    throw new Error(`Codex turn ${turnId} did not stop after interruption`);
  } finally {
    await client.close();
  }
}
