import { createHash } from "node:crypto";

export function privateIdentifier(value) {
  if (!value) return null;
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function createLogger(stream = process.stdout) {
  function write(level, event, fields = {}) {
    stream.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...fields,
      })}\n`,
    );
  }
  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
