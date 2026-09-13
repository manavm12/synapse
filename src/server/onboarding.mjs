import * as z from "zod/v4";

import { createBrowserSessionAuth } from "./browser-session.mjs";
import { AccountDisabledError, UsernameTakenError } from "./database.mjs";
import { privateIdentifier } from "./logger.mjs";

const accountInput = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(32)
      .regex(/^[a-z][a-z0-9_-]{2,31}$/),
    project_alias: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(63)
      .regex(/^[a-z][a-z0-9_-]{1,62}$/),
  })
  .strict();

function accountResponse(account) {
  return {
    status: "ready",
    username: account.username,
    project_alias: account.projectAlias,
  };
}

export function installOnboardingRoutes(
  app,
  config,
  { database, sessionVerifier, logger },
) {
  const authenticate = createBrowserSessionAuth({
    sessionVerifier,
    logger,
    event: "account_authentication_rejected",
  });

  app.get("/auth/account", authenticate, async (req, res) => {
    try {
      const account = await database.getAccount(req.synapseSession.userId);
      res.json(
        account ? accountResponse(account) : { status: "setup_required" },
      );
    } catch (error) {
      if (error instanceof AccountDisabledError) {
        res.status(403).json({ error: "account_disabled" });
        return;
      }
      logger.error("account_status_failed", {
        request_id: req.requestId,
        error_type: error.name,
        user: privateIdentifier(req.synapseSession.userId),
      });
      res.status(503).json({ error: "account_unavailable" });
    }
  });

  app.post("/auth/account", authenticate, async (req, res) => {
    if (!config.publicSignup) {
      res.status(403).json({ error: "registration_closed" });
      return;
    }
    const parsed = accountInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "invalid_account" });
      return;
    }
    try {
      const existing = await database.getAccount(req.synapseSession.userId);
      if (existing) {
        res.json(accountResponse(existing));
        return;
      }
      const account = await database.registerAccount(
        req.synapseSession.userId,
        {
          username: parsed.data.username,
          projectAlias: parsed.data.project_alias,
        },
      );
      logger.info("account_registered", {
        request_id: req.requestId,
        user: privateIdentifier(req.synapseSession.userId),
      });
      res.status(201).json(accountResponse(account));
    } catch (error) {
      if (error instanceof UsernameTakenError) {
        res.status(409).json({ error: "username_taken" });
        return;
      }
      if (error instanceof AccountDisabledError) {
        res.status(403).json({ error: "account_disabled" });
        return;
      }
      logger.error("account_registration_failed", {
        request_id: req.requestId,
        error_type: error.name,
        user: privateIdentifier(req.synapseSession.userId),
      });
      res.status(503).json({ error: "account_unavailable" });
    }
  });
}
