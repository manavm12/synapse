import assert from "node:assert/strict";
import test from "node:test";

import {
  installEmailSubmission,
  isEmailRateLimitError,
} from "../../src/server/public/email-submission.js";

test("email submission is single-flight and starts a cooldown", async () => {
  const button = { disabled: false, textContent: "Send link" };
  const form = {
    addEventListener() {},
    querySelector() {
      return button;
    },
  };
  const panel = { hidden: false };
  const status = { className: "error", textContent: "" };
  let finish;
  let submissions = 0;
  const controller = installEmailSubmission({
    form,
    panel,
    status,
    readEmail: () => "person@example.com",
    showError(error) {
      throw error;
    },
    submit() {
      submissions += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const event = { preventDefault() {} };
  const first = controller.handleSubmit(event);
  const duplicate = controller.handleSubmit(event);
  assert.equal(submissions, 1);
  assert.equal(controller.pending, true);
  assert.equal(button.disabled, true);

  finish({ cooldownSeconds: 60 });
  await Promise.all([first, duplicate]);
  assert.equal(controller.pending, false);
  assert.equal(panel.hidden, true);
  assert.equal(
    status.textContent,
    "Check your email for a one-time sign-in link.",
  );
  assert.equal(button.disabled, true);
  controller.dispose();
});

test("email provider and server cooldown errors are recognized", () => {
  assert.equal(isEmailRateLimitError({ status: 429 }), true);
  assert.equal(isEmailRateLimitError({ code: "email_cooldown" }), true);
  assert.equal(
    isEmailRateLimitError({ message: "Email rate limit exceeded" }),
    true,
  );
  assert.equal(isEmailRateLimitError(new Error("Invalid email")), false);
});
