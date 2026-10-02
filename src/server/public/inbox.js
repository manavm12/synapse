import { installEmailSubmission } from "./email-submission.js";
import {
  buildQuery,
  formatTimestamp,
  inboxErrorMessage,
  nextConversationParams,
  participantName,
  shortenId,
  statusBadge,
} from "./inbox-view.js";

const root = document.querySelector("#app");
const status = document.querySelector("#status");
const login = document.querySelector("#login");
const setup = document.querySelector("#setup");
const header = document.querySelector("#app-header");
const identityEl = document.querySelector("#identity");
const appShell = document.querySelector("#app-shell");
const tabs = document.querySelector("#tabs");
const tabConversations = document.querySelector("#tab-conversations");
const tabInbox = document.querySelector("#tab-inbox");
const conversationDetail = document.querySelector("#conversation-detail");

const client = globalThis.supabase.createClient(
  root.dataset.supabaseUrl,
  root.dataset.supabaseKey,
  {
    auth: {
      flowType: "implicit",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

function showStatus(message, isError = false) {
  status.textContent = message;
  status.className = isError ? "error" : "";
  status.hidden = false;
}

function fail(error) {
  showStatus(error?.message ?? "Failed to load the Synapse inbox.", true);
}

async function authorizedFetch(path) {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    throw (
      error ?? new Error("Your sign-in expired. Sign in again to continue.")
    );
  }
  const response = await fetch(path, {
    headers: { authorization: `Bearer ${data.session.access_token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(inboxErrorMessage(body.error, response.status));
  }
  return body;
}

function badgeCell(td, value) {
  const badge = statusBadge(value);
  const span = document.createElement("span");
  span.className = `badge ${badge.className}`;
  span.textContent = badge.label;
  td.append(span);
}

function appendRow(tbody, cells) {
  const row = document.createElement("tr");
  for (const cell of cells) {
    const td = document.createElement("td");
    if (cell && typeof cell === "object" && "badge" in cell) {
      badgeCell(td, cell.badge);
    } else {
      td.textContent = cell ?? "";
    }
    row.append(td);
  }
  tbody.append(row);
  return row;
}

function makeRowInteractive(row, label, activate) {
  row.classList.add("interactive");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-label", label);
  row.addEventListener("click", activate);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
}

async function withBusy(control, work) {
  if (control.disabled) return;
  control.disabled = true;
  try {
    await work();
  } finally {
    control.disabled = false;
  }
}

let conversationsCursor = null;
async function loadConversations(reset) {
  const tbody = document.querySelector("#conversations-table tbody");
  if (reset) {
    tbody.replaceChildren();
    conversationsCursor = null;
  }
  const query = buildQuery({ cursor: conversationsCursor, limit: 20 });
  const page = await authorizedFetch(`/inbox/conversations?${query}`);
  for (const conversation of page.conversations) {
    const participants = conversation.participants
      .map((participant) => `@${participant.username}`)
      .join(", ");
    const row = appendRow(tbody, [
      participants,
      conversation.preview,
      formatTimestamp(conversation.updated_at),
      conversation.disposition,
      String(conversation.outstanding_replies),
      { badge: conversation.activity_state },
    ]);
    makeRowInteractive(row, `Open conversation with ${participants}`, () => {
      openConversation(conversation.conversation_id).catch(fail);
    });
  }
  conversationsCursor = page.next_cursor;
  document.querySelector("#conversations-more").hidden = !page.next_cursor;
  document.querySelector("#conversations-empty").hidden =
    tbody.children.length !== 0;
}

let openConversationId = null;
let conversationAfterSequence = 0;
async function openConversation(conversationId, reset = true) {
  if (reset) {
    openConversationId = conversationId;
    conversationAfterSequence = 0;
    document.querySelector("#messages-table tbody").replaceChildren();
  }
  const tbody = document.querySelector("#messages-table tbody");
  const conversation = await authorizedFetch(
    `/inbox/conversations/${conversationId}?after_sequence=${conversationAfterSequence}&limit=20`,
  );
  const participantLabels = conversation.participants.map(
    (participant) => `@${participant.username}`,
  );
  document.querySelector("#conversation-detail-title").textContent =
    participantLabels.join(", ");
  for (const message of conversation.messages) {
    appendRow(tbody, [
      String(message.sequence),
      participantName(conversation.participants, message.sender_id),
      message.message,
      { badge: message.status },
      formatTimestamp(message.queued_at),
      { badge: message.response_state },
    ]);
  }
  const params = nextConversationParams(conversation.next_sequence);
  conversationAfterSequence =
    params?.after_sequence ?? conversationAfterSequence;
  document.querySelector("#conversation-more").hidden = !params;
  document.querySelector("#conversation-empty").hidden =
    tbody.children.length !== 0;
  conversationDetail.hidden = false;
  if (reset) conversationDetail.scrollIntoView({ block: "start" });
}

document
  .querySelector("#conversations-more")
  .addEventListener("click", (event) => {
    withBusy(event.currentTarget, () => loadConversations(false)).catch(fail);
  });
document
  .querySelector("#conversation-more")
  .addEventListener("click", (event) => {
    if (openConversationId) {
      withBusy(event.currentTarget, () =>
        openConversation(openConversationId, false),
      ).catch(fail);
    }
  });

let inboxCursor = null;
async function loadInboxFeed(reset) {
  const tbody = document.querySelector("#messages-feed-table tbody");
  if (reset) {
    tbody.replaceChildren();
    inboxCursor = null;
  }
  const statusFilter =
    document.querySelector("#status-filter").value || undefined;
  const query = buildQuery({
    cursor: inboxCursor,
    limit: 20,
    status: statusFilter,
  });
  const page = await authorizedFetch(`/inbox/messages?${query}`);
  for (const message of page.messages) {
    appendRow(tbody, [
      String(message.sequence),
      shortenId(message.conversation_id),
      shortenId(message.sender_id),
      message.message,
      { badge: message.status },
      formatTimestamp(message.queued_at),
    ]);
  }
  inboxCursor = page.next_cursor;
  document.querySelector("#inbox-more").hidden = !page.next_cursor;
  document.querySelector("#inbox-empty").hidden = tbody.children.length !== 0;
}

document.querySelector("#inbox-more").addEventListener("click", (event) => {
  withBusy(event.currentTarget, () => loadInboxFeed(false)).catch(fail);
});
document.querySelector("#status-filter").addEventListener("change", (event) => {
  withBusy(event.currentTarget, () => loadInboxFeed(true)).catch(fail);
});

tabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (!button) return;
  for (const tabButton of tabs.querySelectorAll("button")) {
    const selected = tabButton === button;
    tabButton.classList.toggle("active", selected);
    tabButton.setAttribute("aria-selected", String(selected));
  }
  const showConversations = button.dataset.tab === "conversations";
  tabConversations.hidden = !showConversations;
  tabInbox.hidden = showConversations;
});

document.querySelector("#sign-out").addEventListener("click", async () => {
  const { error } = await client.auth.signOut();
  if (error) {
    fail(error);
    return;
  }
  location.assign("/inbox");
});

installEmailSubmission({
  form: document.querySelector("#login-form"),
  panel: login,
  status,
  showError: fail,
  async submit(email) {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${location.origin}/inbox`,
      },
    });
    if (error) throw error;
    return { cooldownSeconds: 60 };
  },
});

async function start() {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    login.hidden = false;
    showStatus("Sign in with your Synapse account.");
    return;
  }
  const response = await fetch("/auth/account", {
    headers: { authorization: `Bearer ${data.session.access_token}` },
  });
  const account = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Failed to load your Synapse account.");
  if (account.status !== "ready") {
    setup.hidden = false;
    showStatus("Finish setting up your Synapse account.");
    return;
  }
  identityEl.textContent = `@${account.username} / ${account.project_alias}`;
  header.hidden = false;
  status.hidden = true;
  appShell.hidden = false;
  const results = await Promise.allSettled([
    loadConversations(true),
    loadInboxFeed(true),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

start().catch(fail);
