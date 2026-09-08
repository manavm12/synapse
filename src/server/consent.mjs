import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { AuthorizationStateCooldownError } from "./database.mjs";

const COOKIE_NAME = "synapse_authorization";
const AUTHORIZATION_ID = /^[A-Za-z0-9._~-]{1,512}$/;
const AUTHORIZATION_STATE = /^[A-Za-z0-9_-]{43}$/;
const RECEIVER_PAIRING_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signedValue(value, secret) {
  return `${encode(value)}.${sign(value, secret)}`;
}

function stateHash(value) {
  return createHash("sha256").update(value).digest();
}

function verifySignedValue(value, secret) {
  if (typeof value !== "string") return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  try {
    const payload = Buffer.from(
      value.slice(0, separator),
      "base64url",
    ).toString();
    const actual = Buffer.from(value.slice(separator + 1));
    const expected = Buffer.from(sign(payload, secret));
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected) ||
      !AUTHORIZATION_ID.test(payload)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function htmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderPage({ authorizationId, config, mode }) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Authorize Synapse</title>",
    '<link rel="stylesheet" href="/assets/consent.css">',
    "</head>",
    "<body>",
    '<main id="app"',
    ` data-mode="${htmlAttribute(mode)}"`,
    ` data-authorization-id="${htmlAttribute(authorizationId)}"`,
    ` data-supabase-url="${htmlAttribute(config.supabaseUrl.href)}"`,
    ` data-public-signup="${String(config.publicSignup)}"`,
    ' data-supabase-key="' +
      htmlAttribute(config.supabasePublishableKey) +
      '">',
    '<p class="eyebrow">SYNAPSE</p>',
    "<h1>Connecting securely…</h1>",
    '<p id="status">Checking your account and authorization request.</p>',
    '<section id="login" hidden>',
    '<form id="login-form">',
    '<label for="email">Email</label>',
    '<input id="email" name="email" type="email" autocomplete="email" required>',
    '<button type="submit">Email me a sign-in link</button>',
    "</form>",
    "</section>",
    '<section id="setup" hidden>',
    '<form id="setup-form">',
    '<label for="username">Synapse username</label>',
    '<input id="username" name="username" type="text" autocomplete="username" minlength="3" maxlength="32" pattern="[a-z][a-z0-9_-]{2,31}" required>',
    '<p class="hint">Lowercase letters, numbers, underscores, and hyphens.</p>',
    '<label for="project-alias">Project alias</label>',
    '<input id="project-alias" name="project_alias" type="text" minlength="2" maxlength="63" pattern="[a-z][a-z0-9_-]{1,62}" value="synapse" required>',
    '<p class="hint">Use this alias when connecting your local repository.</p>',
    '<button type="submit">Create Synapse identity</button>',
    "</form>",
    "</section>",
    '<section id="consent" hidden>',
    '<p><strong id="client-name"></strong> wants to use your Synapse identity.</p>',
    "<dl>",
    '<dt>Permissions</dt><dd id="scopes"></dd>',
    "<dt>Project</dt><dd>Your single connected Synapse project</dd>",
    "</dl>",
    '<div class="actions">',
    '<button id="deny" class="secondary" type="button">Deny</button>',
    '<button id="approve" type="button">Approve</button>',
    "</div>",
    "</section>",
    "</main>",
    '<script src="/assets/supabase.js"></script>',
    '<script type="module" src="/assets/consent.js"></script>',
    "</body>",
    "</html>",
  ].join("");
}

function authorizationFromRequest(req, secret) {
  return verifySignedValue(
    cookieValue(req.headers.cookie, COOKIE_NAME),
    secret,
  );
}

function setAuthorizationCookie(res, authorizationId, config) {
  const secure = config.production ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    COOKIE_NAME +
      "=" +
      encodeURIComponent(signedValue(authorizationId, config.cookieSecret)) +
      "; Max-Age=600; Path=/; HttpOnly; SameSite=Lax" +
      secure,
  );
}

export function installConsentRoutes(
  app,
  config,
  { database, supabaseBrowserPath },
) {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ${config.supabaseUrl.origin}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const render = (res, values) => {
    res.set("Content-Security-Policy", csp);
    res.set("Cache-Control", "no-store");
    res.type("html").send(renderPage(values));
  };

  app.get("/assets/supabase.js", (_req, res) => {
    res.set("Cache-Control", "public, max-age=86400");
    res.sendFile(supabaseBrowserPath, { dotfiles: "allow" });
  });
  app.get("/assets/consent.js", (_req, res) => {
    res.sendFile(new URL("./public/consent.js", import.meta.url).pathname, {
      dotfiles: "allow",
    });
  });
  app.get("/assets/email-submission.js", (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(
      new URL("./public/email-submission.js", import.meta.url).pathname,
      { dotfiles: "allow" },
    );
  });
  app.get("/assets/consent.css", (_req, res) => {
    res.sendFile(new URL("./public/consent.css", import.meta.url).pathname, {
      dotfiles: "allow",
    });
  });

  app.get("/authorize", (req, res) => {
    const queryId =
      typeof req.query.authorization_id === "string"
        ? req.query.authorization_id
        : null;
    let authorizationId = authorizationFromRequest(req, config.cookieSecret);
    if (queryId) {
      if (!AUTHORIZATION_ID.test(queryId)) {
        res.status(400).send("Invalid authorization request");
        return;
      }
      authorizationId = queryId;
      setAuthorizationCookie(res, queryId, config);
    }
    if (!authorizationId) {
      res.status(400).send("Missing or expired authorization request");
      return;
    }
    render(res, { authorizationId, config, mode: "consent" });
  });

  app.post("/auth/state", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const authorizationId = authorizationFromRequest(req, config.cookieSecret);
    if (!authorizationId) {
      res.status(400).json({ error: "missing_authorization" });
      return;
    }
    if (req.get("x-synapse-auth-request") !== "1") {
      res.status(403).json({ error: "invalid_request" });
      return;
    }
    try {
      const state = randomBytes(32).toString("base64url");
      const created = await database.createAuthorizationState(
        authorizationId,
        stateHash(state),
      );
      const callback = new URL("/auth/callback", config.resourceUrl);
      callback.searchParams.set("state", state);
      res.status(201).json({
        redirect_to: callback.href,
        expires_at: new Date(created.expiresAt).toISOString(),
        cooldown_seconds: 60,
      });
    } catch (error) {
      if (error instanceof AuthorizationStateCooldownError) {
        res.set("Retry-After", "60");
        res.status(429).json({
          error: "email_cooldown",
          retry_after_seconds: 60,
        });
        return;
      }
      res.status(503).json({ error: "authorization_unavailable" });
    }
  });

  app.get("/auth/callback", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!state || !AUTHORIZATION_STATE.test(state)) {
      res.status(400).send("This sign-in link is invalid or expired");
      return;
    }
    let authorizationId;
    try {
      authorizationId = await database.resolveAuthorizationState(
        stateHash(state),
      );
    } catch {
      res.status(503).send("Sign-in is temporarily unavailable");
      return;
    }
    if (!authorizationId || !AUTHORIZATION_ID.test(authorizationId)) {
      res.status(400).send("This sign-in link is invalid or expired");
      return;
    }
    setAuthorizationCookie(res, authorizationId, config);
    render(res, { authorizationId, config, mode: "callback" });
  });

  app.post("/auth/state/consume", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const authorizationId = authorizationFromRequest(req, config.cookieSecret);
    const state = typeof req.body?.state === "string" ? req.body.state : null;
    if (
      !authorizationId ||
      !state ||
      !AUTHORIZATION_STATE.test(state) ||
      req.get("x-synapse-auth-request") !== "1"
    ) {
      res.status(400).json({ error: "invalid_state" });
      return;
    }
    try {
      const consumedAuthorizationId = await database.consumeAuthorizationState(
        stateHash(state),
      );
      if (consumedAuthorizationId !== authorizationId) {
        res.status(400).json({ error: "invalid_state" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(503).json({ error: "authorization_unavailable" });
    }
  });

  app.get("/auth/activate", (req, res) => {
    const pairingId =
      typeof req.query.receiver_pairing === "string"
        ? req.query.receiver_pairing
        : null;
    if (pairingId && !RECEIVER_PAIRING_ID.test(pairingId)) {
      res.status(400).send("Invalid receiver pairing");
      return;
    }
    render(res, {
      authorizationId: pairingId ?? "",
      config,
      mode: pairingId ? "receiver_callback" : "activate",
    });
  });
}
