import { installEmailSubmission } from "./email-submission.js";
import {
  buildQuery,
  nextConversationParams,
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

function fail(error) {
  status.textContent = error?.message ?? "Failed to load the Synapse inbox";
  status.className = "error";
}

async function authorizedFetch(path) {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw error ?? new Error("Sign-in expired");
  const response = await fetch(path, {
    headers: { authorization: `Bearer ${data.session.access_token}` },
  });
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with ${response.status}`);
  }
  return response.json();
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
    const row = appendRow(tbody, [
      conversation.participants.map((p) => `@${p.username}`).join(", "),
      conversation.preview,
      conversation.updated_at,
      conversation.disposition,
      String(conversation.outstanding_replies),
      { badge: conversation.activity_state },
    ]);
    row.tabIndex = 0;
    row.addEventListener("click", () =>
      openConversation(conversation.conversation_id),
    );
  }
  conversationsCursor = page.next_cursor;
  document.querySelector("#conversations-more").hidden = !page.next_cursor;
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
  document.querySelector("#conversation-detail-title").textContent =
    conversation.participants.map((p) => `@${p.username}`).join(", ");
  for (const message of conversation.messages) {
    appendRow(tbody, [
      String(message.sequence),
      message.sender_id,
      message.message,
      { badge: message.status },
      message.queued_at,
      { badge: message.response_state },
    ]);
  }
  const params = nextConversationParams(conversation.next_sequence);
  conversationAfterSequence = params?.after_sequence ?? conversationAfterSequence;
  document.querySelector("#conversation-more").hidden = !params;
  conversationDetail.hidden = false;
}

document.querySelector("#conversations-more").addEventListener("click", () => {
  loadConversations(false).catch(fail);
});
document.querySelector("#conversation-more").addEventListener("click", () => {
  if (openConversationId) openConversation(openConversationId, false).catch(fail);
});

let inboxCursor = null;
async function loadInboxFeed(reset) {
  const tbody = document.querySelector("#messages-feed-table tbody");
  if (reset) {
    tbody.replaceChildren();
    inboxCursor = null;
  }
  const statusFilter = document.querySelector("#status-filter").value || undefined;
  const query = buildQuery({ cursor: inboxCursor, limit: 20, status: statusFilter });
  const page = await authorizedFetch(`/inbox/messages?${query}`);
  for (const message of page.messages) {
    appendRow(tbody, [
      String(message.sequence),
      message.conversation_id,
      message.sender_id,
      message.message,
      { badge: message.status },
      message.queued_at,
    ]);
  }
  inboxCursor = page.next_cursor;
  document.querySelector("#inbox-more").hidden = !page.next_cursor;
}

document.querySelector("#inbox-more").addEventListener("click", () => {
  loadInboxFeed(false).catch(fail);
});
document.querySelector("#status-filter").addEventListener("change", () => {
  loadInboxFeed(true).catch(fail);
});

tabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (!button) return;
  for (const tabButton of tabs.querySelectorAll("button")) {
    tabButton.classList.toggle("active", tabButton === button);
  }
  const showConversations = button.dataset.tab === "conversations";
  tabConversations.hidden = !showConversations;
  tabInbox.hidden = showConversations;
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
    status.textContent = "Sign in with your Synapse account.";
    return;
  }
  const response = await fetch("/auth/account", {
    headers: { authorization: `Bearer ${data.session.access_token}` },
  });
  const account = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Failed to load your Synapse account.");
  if (account.status !== "ready") {
    setup.hidden = false;
    status.textContent = "Finish setting up your Synapse account.";
    return;
  }
  identityEl.textContent = `@${account.username} / ${account.project_alias}`;
  header.hidden = false;
  status.hidden = true;
  appShell.hidden = false;
  await loadConversations(true);
  await loadInboxFeed(true);
}

start().catch(fail);
