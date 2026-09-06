import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDeliveryMarker,
  parseDeliveryMarker,
} from "../../plugins/synapse/lib/markers.mjs";

test("v2 markers round trip delivery identity", () => {
  const marker = formatDeliveryMarker("job:1", "delivery:1");
  assert.equal(marker, "synapse-delivery:v2 job=job%3A1 delivery=delivery%3A1");
  assert.deepEqual(parseDeliveryMarker(`do work\n\n<!-- ${marker} -->`), {
    version: 2,
    jobId: "job:1",
    deliveryId: "delivery:1",
    marker: `<!-- ${marker} -->`,
  });
});

test("markers must be generated as the terminal prompt suffix", () => {
  assert.equal(
    parseDeliveryMarker(
      "<!-- synapse-delivery:v2 job=job-1 delivery=delivery-1 -->\ndo something",
    ),
    null,
  );
  assert.equal(
    parseDeliveryMarker(
      "do something <!-- synapse-delivery:v2 job=job-1 delivery=delivery-1 -->",
    ),
    null,
  );
});

test("legacy markers remain readable but cannot self-observe a delivery", () => {
  assert.deepEqual(
    parseDeliveryMarker("task\n\n<!-- synapse-delivery:job-1 -->"),
    {
      version: 1,
      jobId: "job-1",
      deliveryId: null,
      marker: "<!-- synapse-delivery:job-1 -->",
    },
  );
});
