import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuery,
  formatTimestamp,
  inboxErrorMessage,
  nextConversationParams,
  participantName,
  shortenId,
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

test("formatTimestamp is locale-aware and handles missing or invalid values", () => {
  assert.equal(formatTimestamp(null), "—");
  assert.equal(formatTimestamp("not-a-date"), "—");
  assert.match(formatTimestamp("2026-09-07T12:30:00.000Z", "en-US"), /2026/);
});

test("participantName prefers usernames and safely shortens unknown IDs", () => {
  const participants = [{ user_id: "user-1", username: "alice" }];
  assert.equal(participantName(participants, "user-1"), "@alice");
  assert.equal(
    participantName(participants, "12345678-1234-1234-1234-123456789abc"),
    "12345678…",
  );
  assert.equal(shortenId(null), "Unknown");
  assert.equal(shortenId("short-id"), "short-id");
});

test("inboxErrorMessage maps safe API errors without exposing server detail", () => {
  assert.equal(
    inboxErrorMessage("unauthorized", 401),
    "Your sign-in expired. Sign in again to continue.",
  );
  assert.equal(
    inboxErrorMessage("account_disabled", 403),
    "This Synapse account is disabled.",
  );
  assert.equal(
    inboxErrorMessage("unexpected_internal_value", 503),
    "Inbox request failed (503).",
  );
});
