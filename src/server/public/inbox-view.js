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
