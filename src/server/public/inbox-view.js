const STATUS_BADGES = {
  queued: { label: "Queued", className: "badge-queued" },
  in_receiver_inbox: {
    label: "In receiver inbox",
    className: "badge-in-receiver-inbox",
  },
  provisioning: { label: "Provisioning", className: "badge-provisioning" },
  delivered: { label: "Delivered", className: "badge-delivered" },
  needs_attention: {
    label: "Needs attention",
    className: "badge-needs-attention",
  },
  awaiting_reply: { label: "Awaiting reply", className: "badge-queued" },
  replied: { label: "Replied", className: "badge-delivered" },
  complete: { label: "Complete", className: "badge-delivered" },
  needs_user: { label: "Needs you", className: "badge-needs-attention" },
};

export function statusBadge(status) {
  return (
    STATUS_BADGES[status] ?? {
      label: status ?? "Unknown",
      className: "badge-unknown",
    }
  );
}

export function buildQuery({ cursor, limit, status } = {}) {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (limit) params.set("limit", String(limit));
  if (status) params.set("status", status);
  return params.toString();
}

export function nextConversationParams(nextSequence) {
  return nextSequence == null ? null : { after_sequence: nextSequence };
}

export function formatTimestamp(value, locale) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function shortenId(value) {
  if (!value) return "Unknown";
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

export function participantName(participants, userId) {
  const participant = participants?.find((item) => item.user_id === userId);
  return participant?.username ? `@${participant.username}` : shortenId(userId);
}

export function inboxErrorMessage(code, status) {
  const messages = {
    unauthorized: "Your sign-in expired. Sign in again to continue.",
    setup_required: "Finish setting up your Synapse account in Codex.",
    account_disabled: "This Synapse account is disabled.",
    invalid_request: "The inbox request was invalid. Refresh and try again.",
    invalid_cursor: "This page is no longer available. Refresh the inbox.",
    not_found: "That conversation is no longer available.",
    account_unavailable: "Your Synapse account is temporarily unavailable.",
    inbox_unavailable: "The Synapse inbox is temporarily unavailable.",
  };
  return messages[code] ?? `Inbox request failed (${status}).`;
}
