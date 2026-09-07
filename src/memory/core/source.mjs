import { createHash } from "node:crypto";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MARKDOWN_BYTES = 128 * 1024;
const MAX_SEGMENTS = 160;

export const hash = (value) => createHash("sha256").update(value).digest("hex");

function requiredString(value, name, maximum = 20_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(
      `${name} must be non-empty text of at most ${maximum} characters`,
    );
}

function uuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error(`${name} must be a UUID`);
}

export function validateIdentity(identity, label = "identity") {
  if (!identity || typeof identity !== "object")
    throw new Error(`${label} is required`);
  uuid(identity.ownerId, `${label}.ownerId`);
  uuid(identity.projectId, `${label}.projectId`);
  return identity;
}

function timestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error(`${name} must be an ISO timestamp`);
}

export function normalizeSourceEnvelope(envelope, expectedIdentity) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    throw new Error("Source envelope must be an object");
  if (envelope.version !== 1)
    throw new Error("Unsupported source envelope version");
  for (const name of [
    "ownerId",
    "projectId",
    "revisionId",
    "nodeId",
    "captureId",
  ])
    uuid(envelope[name], name);
  requiredString(envelope.sessionId, "sessionId");
  requiredString(envelope.title, "title");
  if (typeof envelope.summary !== "string" || envelope.summary.length > 20_000)
    throw new Error("summary must be text of at most 20000 characters");
  if (typeof envelope.markdown !== "string")
    throw new Error("markdown must be text");
  if (Buffer.byteLength(envelope.markdown) > MAX_MARKDOWN_BYTES)
    throw new Error("markdown must be no larger than 128 KiB");
  if (!Number.isSafeInteger(envelope.revision) || envelope.revision < 1)
    throw new Error("revision must be a positive integer");
  timestamp(envelope.capturedAt, "capturedAt");
  validateIdentity(expectedIdentity, "Trusted adapter identity");
  if (envelope.ownerId !== expectedIdentity.ownerId)
    throw new Error("Source owner does not match trusted adapter identity");
  if (envelope.projectId !== expectedIdentity.projectId)
    throw new Error("Source project does not match trusted adapter identity");

  return Object.freeze({
    ...envelope,
    id: envelope.revisionId,
    contentHash: hash(envelope.markdown),
  });
}

export function segmentsFor(source) {
  const segments = [];
  let section = "Context";
  const frontmatterLength =
    source.markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ??
    0;
  const remainder = source.markdown.slice(frontmatterLength);
  let begin = null;
  let end = null;
  let fenced = false;
  const flush = () => {
    if (begin === null) return;
    const raw = source.markdown.slice(begin, end);
    const text = raw.trim();
    const offset = begin + raw.indexOf(text);
    segments.push({
      id: `seg:${hash(`${source.revisionId}:${offset}:${text.length}`).slice(0, 20)}`,
      section,
      text,
      start: offset,
      end: offset + text.length,
      documentId: source.revisionId,
    });
    begin = null;
    end = null;
  };
  for (const match of remainder.matchAll(/[^\r\n]+(?:\r?\n|$)|\r?\n/g)) {
    const line = match[0].replace(/\r?\n$/, "");
    const heading = !fenced && line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flush();
      section = heading[1].trim();
      continue;
    }
    if (!line.trim() && !fenced) {
      flush();
      continue;
    }
    if (begin === null) begin = frontmatterLength + match.index;
    end = frontmatterLength + match.index + line.length;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
  }
  flush();
  if (segments.length > MAX_SEGMENTS)
    throw new Error(
      "Source has more than 160 segments; split the capture without truncation",
    );
  return segments;
}
