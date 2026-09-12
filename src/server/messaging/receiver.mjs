import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

import * as z from "zod/v4";

import { MessagingError } from "./errors.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL = /^syn_recv_[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;

const pairingInput = z
  .object({ credential_hash: z.string().regex(HASH) })
  .strict();
const claimInput = z
  .object({ limit: z.number().int().min(1).max(10).default(10) })
  .extend({ version: z.union([z.literal(1), z.literal(2)]).default(1) })
  .strict();
const importInput = z
  .object({
    message_id: z.uuid(),
    claim_token: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const eventsInput = z
  .object({
    events: z
      .array(
        z
          .object({
            event_id: z.uuid(),
            message_id: z.uuid(),
            kind: z.enum(["provisioning", "delivered", "needs_attention"]),
            occurred_at: z.iso.datetime({ offset: true }),
            error_code: z
              .string()
              .regex(/^[a-z0-9_]{1,64}$/)
              .optional(),
          })
          .strict()
          .superRefine((event, context) => {
            if (event.kind === "needs_attention" && !event.error_code) {
              context.addIssue({
                code: "custom",
                message: "error_code is required",
              });
            }
            if (event.kind !== "needs_attention" && event.error_code) {
              context.addIssue({
                code: "custom",
                message: "error_code is not allowed",
              });
            }
          }),
      )
      .min(1)
      .max(100),
  })
  .strict();

function bearerCredential(req) {
  const value = req.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  const credential = value.slice(7).trim();
  return CREDENTIAL.test(credential) ? credential : null;
}

function receiverIdentity(value) {
  return {
    installation_id: value.installationId,
    user_id: value.userId,
    username: value.username,
    project_id: value.projectId,
    project_alias: value.projectAlias,
    expires_at: new Date(value.expiresAt).toISOString(),
    enabled: true,
  };
}

function cloudMessage(value) {
  return {
    version: value.version ?? 1,
    message_id: value.messageId,
    conversation_id: value.conversationId,
    sequence: value.sequence,
    sender: { user_id: value.sender.userId, username: value.sender.username },
    recipient: {
      user_id: value.recipient.userId,
      project_id: value.recipient.projectId,
    },
    message: value.message,
    content_hash: value.contentHash,
    claim_token: value.claimToken,
    lease_expires_at: new Date(value.leaseExpiresAt).toISOString(),
    ...(value.version === 2
      ? {
          disposition: value.disposition,
          in_reply_to_message_id: value.inReplyToMessageId,
          recipient_origin_request_id: value.recipientOriginRequestId,
        }
      : {}),
  };
}

function receiverPage(config, pairingId) {
  const values = {
    pairing: pairingId,
    supabaseUrl: config.supabaseUrl.href,
    supabaseKey: config.supabasePublishableKey,
  };
  const escapeAttribute = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Synapse receiver</title><link rel="stylesheet" href="/assets/receiver-pairing.css"></head><body><main id="app" data-pairing-id="${escapeAttribute(values.pairing)}" data-supabase-url="${escapeAttribute(values.supabaseUrl)}" data-supabase-key="${escapeAttribute(values.supabaseKey)}"><p class="eyebrow">SYNAPSE RECEIVER</p><h1>Connect this installation</h1><p id="status">Sign in to review the receiver connection.</p><section id="login" hidden><form id="login-form"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required><button type="submit">Email me a sign-in link</button></form></section><section id="consent" hidden><p>You are connecting <strong id="identity"></strong>.</p><p>Once enabled, any active signed-in Synapse user can send tasks that this installation will automatically route into this project.</p><p>No local path, native task ID, or receiver secret is shared with Synapse users.</p><button id="approve" type="button">Enable incoming tasks</button></section></main><script src="/assets/supabase.js"></script><script type="module" src="/assets/receiver-pairing.js"></script></body></html>`;
}

export function installReceiverRoutes(
  app,
  config,
  { database, sessionVerifier, logger },
) {
  const respondError = (res, error) => {
    const status = error instanceof MessagingError ? error.status : 503;
    const code =
      error instanceof MessagingError ? error.code : "receiver_unavailable";
    res.status(status).json({ error: code });
  };
  const receiver = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const credential = bearerCredential(req);
    if (!credential) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const identity = await database.getReceiverIdentity(credential);
      if (!identity) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      req.receiverCredential = credential;
      req.receiverIdentity = identity;
      next();
    } catch (error) {
      logger.info("receiver_authentication_rejected", {
        request_id: req.requestId ?? null,
        error_type: error.name,
      });
      res.status(401).json({ error: "unauthorized" });
    }
  };
  const browserSession = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const value = req.headers.authorization;
    const token =
      typeof value === "string" && value.startsWith("Bearer ")
        ? value.slice(7).trim()
        : null;
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      req.synapseSession = await sessionVerifier.verifyAccessToken(token);
      next();
    } catch {
      res.status(401).json({ error: "unauthorized" });
    }
  };

  app.get("/assets/receiver-pairing.js", (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(
      fileURLToPath(new URL("../public/receiver-pairing.js", import.meta.url)),
    );
  });
  app.get("/assets/receiver-pairing.css", (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(
      fileURLToPath(new URL("../public/receiver-pairing.css", import.meta.url)),
    );
  });

  app.post("/receiver/pairings", async (req, res) => {
    const parsed = pairingInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "invalid_request" });
      return;
    }
    try {
      const requesterHash = createHmac("sha256", config.cookieSecret)
        .update(req.ip ?? "unknown")
        .digest();
      const pairing = await database.createReceiverPairing(
        parsed.data.credential_hash,
        requesterHash,
      );
      res.status(201).json({
        pairing_id: pairing.pairingId,
        verification_url: new URL(
          `/receiver/pairings/${pairing.pairingId}`,
          config.resourceUrl,
        ).href,
        expires_at: pairing.expiresAt.toISOString(),
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  app.get("/receiver/pairings/:pairing_id", (req, res) => {
    if (!UUID.test(req.params.pairing_id)) {
      res.status(404).send("Pairing not found");
      return;
    }
    const csp = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      `connect-src 'self' ${config.supabaseUrl.origin}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
    res.set("Content-Security-Policy", csp);
    res.set("Cache-Control", "no-store");
    res.type("html").send(receiverPage(config, req.params.pairing_id));
  });

  app.post(
    "/auth/receiver-pairings/:pairing_id/approve",
    browserSession,
    async (req, res) => {
      if (!UUID.test(req.params.pairing_id)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      try {
        const identity = await database.approveReceiverPairing(
          req.synapseSession.userId,
          req.params.pairing_id,
        );
        res.json({ identity: receiverIdentity(identity) });
      } catch (error) {
        respondError(res, error);
      }
    },
  );

  app.post("/receiver/pairings/:pairing_id/complete", async (req, res) => {
    const credential = bearerCredential(req);
    if (!credential) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!UUID.test(req.params.pairing_id)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      const completion = await database.completeReceiverPairing(
        credential,
        req.params.pairing_id,
      );
      if (completion.status === "pending") {
        res.status(202).json({ status: "pending" });
      } else {
        res.json({
          status: "connected",
          identity: receiverIdentity(completion.identity),
        });
      }
    } catch (error) {
      respondError(res, error);
    }
  });

  app.get("/receiver/identity", receiver, (req, res) => {
    res.json({ identity: receiverIdentity(req.receiverIdentity) });
  });

  app.post("/receiver/claim", receiver, async (req, res) => {
    const parsed = claimInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(422).json({ error: "invalid_request" });
      return;
    }
    try {
      const claimed = await database.claimReceiverMessages(
        req.receiverCredential,
        parsed.data.limit,
        parsed.data.version,
      );
      res.json({
        identity: receiverIdentity(req.receiverIdentity),
        messages: claimed.messages.map(cloudMessage),
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  app.post("/receiver/import", receiver, async (req, res) => {
    const parsed = importInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "invalid_request" });
      return;
    }
    try {
      const imported = await database.importReceiverMessage(
        req.receiverCredential,
        {
          messageId: parsed.data.message_id,
          claimToken: parsed.data.claim_token,
        },
      );
      res.json({ message_id: imported.messageId, status: imported.status });
    } catch (error) {
      respondError(res, error);
    }
  });

  app.get("/receiver/messages/:message_id", receiver, async (req, res) => {
    if (!UUID.test(req.params.message_id)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      const message = await database.getReceiverMessage(
        req.receiverCredential,
        req.params.message_id,
      );
      if (!message) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        message_id: message.messageId,
        status: message.status,
        imported: message.imported,
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  app.post("/receiver/events", receiver, async (req, res) => {
    const parsed = eventsInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "invalid_request" });
      return;
    }
    try {
      const accepted = await database.recordReceiverEvents(
        req.receiverCredential,
        parsed.data.events.map((event) => ({
          eventId: event.event_id,
          messageId: event.message_id,
          kind: event.kind,
          occurredAt: event.occurred_at,
          errorCode: event.error_code,
        })),
      );
      res.json({ accepted_event_ids: accepted });
    } catch (error) {
      respondError(res, error);
    }
  });

  app.post("/receiver/disconnect", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const credential = bearerCredential(req);
    if (!credential) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const disconnected = await database.disconnectReceiver(credential);
      if (!disconnected) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      res.json({ disconnected: true });
    } catch (error) {
      respondError(res, error);
    }
  });
}
