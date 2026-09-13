import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuery,
  nextConversationParams,
  statusBadge,
} from "../../src/server/public/inbox-view.js";

test("statusBadge maps every public message status and falls back safely", () => {
  assert.deepEqual(statusBadge("queued"), {
    label: "Queued",
    className: "badge-queued",
  });
  assert.deepEqual(statusBadge("in_receiver_inbox"), {
    label: "In receiver inbox",
    className: "badge-in-receiver-inbox",
  });
  assert.deepEqual(statusBadge("provisioning"), {
    label: "Provisioning",
    className: "badge-provisioning",
  });
  assert.deepEqual(statusBadge("delivered"), {
    label: "Delivered",
    className: "badge-delivered",
  });
  assert.deepEqual(statusBadge("needs_attention"), {
    label: "Needs attention",
    className: "badge-needs-attention",
  });
  assert.deepEqual(statusBadge("something_unexpected"), {
    label: "something_unexpected",
    className: "badge-unknown",
  });
  assert.deepEqual(statusBadge(undefined), {
    label: "Unknown",
    className: "badge-unknown",
  });
});

test("buildQuery only includes provided parameters", () => {
  assert.equal(buildQuery(), "");
  assert.equal(buildQuery({ limit: 20 }), "limit=20");
  assert.equal(
    buildQuery({ cursor: "abc", limit: 20, status: "queued" }),
    "cursor=abc&limit=20&status=queued",
  );
  assert.equal(buildQuery({ cursor: null, status: undefined }), "");
});

test("nextConversationParams is null once a conversation has no more pages", () => {
  assert.equal(nextConversationParams(null), null);
  assert.deepEqual(nextConversationParams(42), { after_sequence: 42 });
});
