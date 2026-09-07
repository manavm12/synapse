import assert from "node:assert/strict";
import test from "node:test";

import {
  MessagingError,
  messagingError,
} from "../../src/server/messaging/errors.mjs";
import {
  decodeCursor,
  encodeCursor,
  sendMessageInputSchema,
} from "../../src/server/messaging/schemas.mjs";

test("messaging errors expose bounded public codes", () => {
  const existing = new MessagingError("known", "Known", { status: 409 });
  assert.equal(messagingError(existing), existing);
  const cases = [
    ["23505", "conflict", 409],
    ["42501", "forbidden", 403],
    ["P0002", "not_found", 404],
    ["54000", "rate_limited", 429],
    ["22023", "invalid_request", 422],
    ["XX000", "messaging_unavailable", 503],
  ];
  for (const [databaseCode, publicCode, status] of cases) {
    const error = messagingError({ code: databaseCode, message: "bounded" });
    assert.equal(error.code, publicCode);
    assert.equal(error.status, status);
  }
});

test("inbox cursors round trip and reject malformed state", () => {
  const value = {
    queuedAt: "2026-09-07T10:00:00.000Z",
    messageId: "11111111-1111-4111-8111-111111111111",
  };
  assert.deepEqual(decodeCursor(encodeCursor(value)), value);
  assert.equal(decodeCursor(undefined), null);
  assert.throws(() => decodeCursor("not-json"), /cursor is invalid/);
});

test("message schemas normalize usernames and enforce the 60 KiB boundary", () => {
  const parsed = sendMessageInputSchema.parse({
    to_username: "@USER_NAME",
    message: "x".repeat(61_440),
    request_id: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(parsed.to_username, "@user_name");
  assert.equal(
    sendMessageInputSchema.safeParse({
      ...parsed,
      message: `${parsed.message}x`,
    }).success,
    false,
  );
});
