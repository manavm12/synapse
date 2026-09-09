export async function readInput(stream = process.stdin, { line = false } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Synapse input is too large");
    chunks.push(buffer);
    if (line && buffer.includes(10)) break;
  }
  const input = Buffer.concat(chunks).toString("utf8");
  const value = JSON.parse((line ? input.split("\n")[0] : input) || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Synapse input");
  return value;
}

export const safeSessionId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
