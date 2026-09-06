import assert from "node:assert/strict";
import test from "node:test";

import { createLogger, privateIdentifier } from "../../src/server/logger.mjs";

test("structured logging hashes private identifiers and writes both levels", () => {
  const lines = [];
  const logger = createLogger({
    write(line) {
      lines.push(JSON.parse(line));
    },
  });

  assert.equal(privateIdentifier(null), null);
  assert.match(privateIdentifier("private-user"), /^[0-9a-f]{16}$/);
  logger.info("started", { port: 8787 });
  logger.error("failed", { stage: "database" });

  assert.deepEqual(
    lines.map(({ level, event }) => ({ level, event })),
    [
      { level: "info", event: "started" },
      { level: "error", event: "failed" },
    ],
  );
  assert.equal(lines[0].port, 8787);
  assert.equal(lines[1].stage, "database");
  assert.match(lines[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
