export function isEmailRateLimitError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    error?.status === 429 ||
    error?.code === "email_cooldown" ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  );
}

export function installEmailSubmission({
  form,
  panel,
  status,
  submit,
  showError,
  successMessage = "Check your email for a one-time sign-in link.",
  cooldownSeconds = 60,
  readEmail = () => String(new FormData(form).get("email") ?? ""),
  now = Date.now,
}) {
  const button = form.querySelector("button[type=submit]");
  const defaultLabel = button.textContent;
  let pending = false;
  let cooldownUntil = 0;
  let timer = null;

  function updateCooldown() {
    const remaining = Math.max(0, Math.ceil((cooldownUntil - now()) / 1_000));
    if (remaining === 0) {
      clearInterval(timer);
      timer = null;
      button.disabled = false;
      button.textContent = defaultLabel;
      return;
    }
    button.disabled = true;
    button.textContent = `Try again in ${remaining}s`;
  }

  function startCooldown(seconds = cooldownSeconds) {
    cooldownUntil = now() + seconds * 1_000;
    updateCooldown();
    if (!timer) timer = setInterval(updateCooldown, 1_000);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (pending || now() < cooldownUntil) return;

    pending = true;
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const result = await submit(readEmail());
      startCooldown(result?.cooldownSeconds);
      panel.hidden = true;
      status.className = "";
      status.textContent = successMessage;
    } catch (error) {
      if (isEmailRateLimitError(error)) {
        startCooldown(error.retryAfterSeconds ?? cooldownSeconds);
        showError(
          new Error("Please wait a minute before requesting another link."),
        );
      } else {
        button.disabled = false;
        button.textContent = defaultLabel;
        showError(error);
      }
    } finally {
      pending = false;
    }
  }

  form.addEventListener("submit", handleSubmit);

  return {
    handleSubmit,
    get pending() {
      return pending;
    },
    dispose() {
      if (timer) clearInterval(timer);
    },
  };
}
