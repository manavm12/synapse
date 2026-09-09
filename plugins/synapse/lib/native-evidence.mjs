import { parseDeliveryMarker } from "./markers.mjs";

function decodeXmlText(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

export function delegationFromOutput(output, { receiptOnly = false } = {}) {
  if (output?.truncated === true && !receiptOnly) return null;
  const raw = typeof output === "string" ? output : output?.text;
  if (typeof raw !== "string") return null;
  const text = raw.trimStart();
  if (!text.startsWith("<codex_delegation>")) return null;
  const source = text.match(/<source_thread_id>([^<]+)<\/source_thread_id>/);
  const taskInput = receiptOnly
    ? text.match(/<input>([^\n]*)(?:\n|<\/input>)/)
    : text.match(/<input>([\s\S]*?)<\/input>/);
  if (!source || !taskInput) return null;
  return {
    sourceThreadId: decodeXmlText(source[1]).trim(),
    taskInput: decodeXmlText(taskInput[1]),
  };
}

export function delegationMatches(job, output) {
  // Only an exact leading receipt is usable when the native API truncates a
  // long task. The caller still verifies native provenance, source and project.
  const delegation = delegationFromOutput(output, {
    receiptOnly: output?.truncated === true,
  });
  const marker = parseDeliveryMarker(delegation?.taskInput);
  return Boolean(
    marker?.version === 2 &&
      marker.jobId === job.jobId &&
      marker.deliveryId === job.deliveryId &&
      delegation.sourceThreadId === job.ownerSessionId,
  );
}
