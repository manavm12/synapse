const SAFE_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

function requireMarkerId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

export function formatDeliveryMarker(jobId, deliveryId) {
  requireMarkerId(jobId, "job ID");
  requireMarkerId(deliveryId, "delivery ID");
  return `synapse-delivery:v2 job=${encodeURIComponent(jobId)} delivery=${encodeURIComponent(deliveryId)}`;
}

export function formatLegacyDeliveryMarker(jobId) {
  requireMarkerId(jobId, "job ID");
  return `synapse-delivery:${jobId}`;
}

export function parseDeliveryMarker(prompt) {
  if (typeof prompt !== "string") {
    return null;
  }

  const versionTwo = prompt.match(
    /(?:^|\n\n)<!-- synapse-delivery:v2 job=([^\s]+) delivery=([^\s]+) -->\s*$/,
  );
  if (versionTwo) {
    let jobId;
    let deliveryId;
    try {
      jobId = decodeURIComponent(versionTwo[1]);
      deliveryId = decodeURIComponent(versionTwo[2]);
      requireMarkerId(jobId, "job ID");
      requireMarkerId(deliveryId, "delivery ID");
    } catch {
      return null;
    }
    return { version: 2, jobId, deliveryId, marker: versionTwo[0].trim() };
  }

  const legacy = prompt.match(
    /(?:^|\n\n)<!-- synapse-delivery:([a-zA-Z0-9._:-]{1,128}) -->\s*$/,
  );
  return legacy
    ? {
        version: 1,
        jobId: legacy[1],
        deliveryId: null,
        marker: legacy[0].trim(),
      }
    : null;
}
