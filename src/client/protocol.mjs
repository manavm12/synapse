const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);

export function requireIdentifier(value, name) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${name} must match ${IDENTIFIER}`);
  }
  return value;
}

export function validateTaskSubmission(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Task body must be a JSON object");
  }

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    throw new Error("prompt must be a non-empty string");
  }
  if (prompt.length > 100_000) {
    throw new Error("prompt exceeds the 100000 character local-spike limit");
  }

  return {
    hostId: requireIdentifier(input.hostId ?? "local", "hostId"),
    conversationId: requireIdentifier(input.conversationId, "conversationId"),
    project: requireIdentifier(input.project, "project"),
    prompt,
  };
}

export function taskEvent(task) {
  return {
    id: task.id,
    hostId: task.hostId,
    conversationId: task.conversationId,
    project: task.project,
    prompt: task.prompt,
    status: task.status,
    threadId: task.threadId ?? null,
    worktreePath: task.worktreePath ?? null,
    result: task.result ?? null,
    error: task.error ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
