export class MessagingError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = "MessagingError";
    this.code = code;
    this.status = status;
  }
}

export function messagingError(error) {
  if (error instanceof MessagingError) return error;
  if (error?.code === "23505") {
    return new MessagingError(
      "conflict",
      error.message?.includes("request_id")
        ? "request_id was already used with different message parameters"
        : "The requested messaging operation conflicts with existing state",
      { status: 409 },
    );
  }
  if (error?.code === "42501") {
    return new MessagingError("forbidden", "Messaging access was denied", {
      status: 403,
    });
  }
  if (error?.code === "P0002") {
    return new MessagingError(
      "not_found",
      "Messaging resource is unavailable",
      {
        status: 404,
      },
    );
  }
  if (error?.code === "54000") {
    return new MessagingError("rate_limited", error.message, { status: 429 });
  }
  if (error?.code === "22001" || error?.code === "22023") {
    return new MessagingError("invalid_request", error.message, {
      status: 422,
    });
  }
  return new MessagingError(
    "messaging_unavailable",
    "Synapse messaging is temporarily unavailable",
    { status: 503 },
  );
}
