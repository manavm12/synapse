import { setTimeout as delay } from "node:timers/promises";

export async function withDeadline(
  operation,
  {
    timeoutMs = 30_000,
    signal: parent,
    message = "Synapse operation timed out; retry from Synapse setup.",
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Timeout must be a positive integer");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(message);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  const signal = controller.signal;
  let rejectAbort;
  const cancelled = new Promise((_, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([
      Promise.resolve().then(() => operation(signal)),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
    signal.removeEventListener("abort", rejectAbort);
  }
}

export function waitForApproval(milliseconds, signal) {
  return delay(milliseconds, undefined, { signal });
}
