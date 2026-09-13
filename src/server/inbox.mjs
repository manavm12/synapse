import { fileURLToPath } from "node:url";

import * as z from "zod/v4";

import { createBrowserSessionAuth } from "./browser-session.mjs";
import { AccountDisabledError } from "./database.mjs";
import { MessagingError } from "./messaging/errors.mjs";
import {
  decodeCursor,
  encodeCursor,
  publicStatusSchema,
} from "./messaging/schemas.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const listQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const messagesQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: publicStatusSchema.optional(),
  })
  .strict();
const conversationQuerySchema = z
  .object({
    after_sequence: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function parseCursor(raw) {
  try {
    return { ok: true, value: decodeCursor(raw) };
  } catch {
    return { ok: false };
  }
}

function inboxPage(config) {
  const escapeAttribute = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Synapse inbox</title>
  <link rel="stylesheet" href="/assets/inbox.css">
</head>
<body>
<main id="app" data-supabase-url="${escapeAttribute(config.supabaseUrl.href)}" data-supabase-key="${escapeAttribute(config.supabasePublishableKey)}">
  <header id="app-header" hidden>
    <div><p class="eyebrow">SYNAPSE INBOX</p><h1 id="identity"></h1></div>
    <button type="button" id="sign-out" class="secondary">Sign out</button>
  </header>
  <p id="status" role="status" aria-live="polite">Sign in to view your Synapse inbox.</p>
  <section id="login" class="panel" hidden>
    <form id="login-form">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required>
      <button type="submit">Email me a sign-in link</button>
    </form>
  </section>
  <section id="setup" class="panel" hidden>
    <p>Finish setting up your Synapse account in Codex before viewing the web inbox.</p>
  </section>
  <section id="app-shell" hidden>
    <nav id="tabs" role="tablist" aria-label="Inbox views">
      <button type="button" id="conversations-tab" role="tab" aria-controls="tab-conversations" aria-selected="true" data-tab="conversations" class="active">Conversations</button>
      <button type="button" id="inbox-tab" role="tab" aria-controls="tab-inbox" aria-selected="false" data-tab="inbox">Inbox</button>
    </nav>
    <section id="tab-conversations" role="tabpanel" aria-labelledby="conversations-tab">
      <p id="conversations-empty" class="empty" hidden>No conversations yet.</p>
      <div class="table-scroll"><table id="conversations-table"><thead><tr><th>Participants</th><th>Preview</th><th>Updated</th><th>Disposition</th><th>Outstanding</th><th>Activity</th></tr></thead><tbody></tbody></table></div>
      <button type="button" id="conversations-more" hidden>Load more</button>
      <section id="conversation-detail" hidden>
        <h2 id="conversation-detail-title"></h2>
        <p id="conversation-empty" class="empty" hidden>No messages in this conversation.</p>
        <div class="table-scroll"><table id="messages-table"><thead><tr><th>Seq</th><th>Sender</th><th>Message</th><th>Status</th><th>Queued</th><th>Response</th></tr></thead><tbody></tbody></table></div>
        <button type="button" id="conversation-more" hidden>Load more</button>
      </section>
    </section>
    <section id="tab-inbox" role="tabpanel" aria-labelledby="inbox-tab" hidden>
      <label for="status-filter">Status</label>
      <select id="status-filter"><option value="">All</option><option value="queued">Queued</option><option value="in_receiver_inbox">In receiver inbox</option><option value="provisioning">Provisioning</option><option value="delivered">Delivered</option><option value="needs_attention">Needs attention</option></select>
      <p id="inbox-empty" class="empty" hidden>No messages match this filter.</p>
      <div class="table-scroll"><table id="messages-feed-table"><thead><tr><th>Seq</th><th>Conversation</th><th>Sender</th><th>Message</th><th>Status</th><th>Queued</th></tr></thead><tbody></tbody></table></div>
      <button type="button" id="inbox-more" hidden>Load more</button>
    </section>
  </section>
</main>
<script src="/assets/supabase.js"></script>
<script type="module" src="/assets/inbox.js"></script>
</body>
</html>`;
}

export function installInboxRoutes(
  app,
  config,
  { database, sessionVerifier, logger },
) {
  const browserSession = createBrowserSessionAuth({
    sessionVerifier,
    logger,
    event: "inbox_authentication_rejected",
  });
  const withAccount = async (req, res, next) => {
    try {
      const account = await database.getAccount(req.synapseSession.userId);
      if (!account) {
        res.status(403).json({ error: "setup_required" });
        return;
      }
      req.synapseAccount = account;
      next();
    } catch (error) {
      if (error instanceof AccountDisabledError) {
        res.status(403).json({ error: "account_disabled" });
        return;
      }
      logger.error("inbox_account_lookup_failed", {
        request_id: req.requestId ?? null,
        error_type: error.name,
      });
      res.status(503).json({ error: "account_unavailable" });
    }
  };
  const respondError = (res, error) => {
    const status = error instanceof MessagingError ? error.status : 503;
    const code =
      error instanceof MessagingError ? error.code : "inbox_unavailable";
    res.status(status).json({ error: code });
  };
  const asUser = (req) => ({ userId: req.synapseSession.userId });

  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ${config.supabaseUrl.origin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  app.get("/inbox", (_req, res) => {
    res.set("Content-Security-Policy", csp);
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.type("html").send(inboxPage(config));
  });
  app.get("/assets/inbox.js", (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(fileURLToPath(new URL("./public/inbox.js", import.meta.url)), {
      dotfiles: "allow",
    });
  });
  app.get("/assets/inbox-view.js", (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(
      fileURLToPath(new URL("./public/inbox-view.js", import.meta.url)),
      {
        dotfiles: "allow",
      },
    );
  });
  app.get("/assets/inbox.css", (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(
      fileURLToPath(new URL("./public/inbox.css", import.meta.url)),
      {
        dotfiles: "allow",
      },
    );
  });

  app.get(
    "/inbox/conversations",
    browserSession,
    withAccount,
    async (req, res) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({ error: "invalid_request" });
        return;
      }
      const cursor = parseCursor(parsed.data.cursor);
      if (!cursor.ok) {
        res.status(422).json({ error: "invalid_cursor" });
        return;
      }
      try {
        const page = await database.listConversations(asUser(req), {
          limit: parsed.data.limit,
          before: cursor.value,
        });
        res.json({
          conversations: page.conversations,
          next_cursor: encodeCursor(page.next),
        });
      } catch (error) {
        respondError(res, error);
      }
    },
  );

  app.get(
    "/inbox/conversations/:conversation_id",
    browserSession,
    withAccount,
    async (req, res) => {
      if (!UUID.test(req.params.conversation_id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const parsed = conversationQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({ error: "invalid_request" });
        return;
      }
      try {
        const conversation = await database.getConversation(asUser(req), {
          conversationId: req.params.conversation_id,
          afterSequence: parsed.data.after_sequence,
          limit: parsed.data.limit,
        });
        res.json(conversation);
      } catch (error) {
        respondError(res, error);
      }
    },
  );

  app.get("/inbox/messages", browserSession, withAccount, async (req, res) => {
    const parsed = messagesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ error: "invalid_request" });
      return;
    }
    const cursor = parseCursor(parsed.data.cursor);
    if (!cursor.ok) {
      res.status(422).json({ error: "invalid_cursor" });
      return;
    }
    try {
      const inbox = await database.listInbox(asUser(req), {
        limit: parsed.data.limit,
        status: parsed.data.status,
        before: cursor.value,
      });
      res.json({
        messages: inbox.messages.map((message) => ({
          message_id: message.messageId,
          conversation_id: message.conversationId,
          sequence: message.sequence,
          sender_id: message.senderId,
          message: message.message,
          content_hash: message.contentHash,
          status: message.status,
          queued_at: iso(message.queuedAt),
        })),
        next_cursor: encodeCursor(inbox.next),
      });
    } catch (error) {
      respondError(res, error);
    }
  });
}
