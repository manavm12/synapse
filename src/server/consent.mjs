import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "synapse_authorization";
const AUTHORIZATION_ID = /^[A-Za-z0-9._~-]{1,512}$/;

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signedValue(value, secret) {
  return `${encode(value)}.${sign(value, secret)}`;
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
    ' data-supabase-key="' +
      htmlAttribute(config.supabasePublishableKey) +
      '">',
    '<p class="eyebrow">SYNAPSE</p>',
    "<h1>Connecting securely…</h1>",
    '<p id="status">Checking your account and authorization request.</p>',
    '<section id="login" hidden>',
    '<form id="login-form">',
    '<label for="email">Invited email</label>',
    '<input id="email" name="email" type="email" autocomplete="email" required>',
    '<button type="submit">Email me a sign-in link</button>',
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
    '<script src="/assets/consent.js" defer></script>',
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

export function installConsentRoutes(app, config, { supabaseBrowserPath }) {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ${config.supabaseUrl.origin}`,
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
      const secure = config.production ? "; Secure" : "";
      res.append(
        "Set-Cookie",
        COOKIE_NAME +
          "=" +
          encodeURIComponent(signedValue(queryId, config.cookieSecret)) +
          "; Max-Age=600; Path=/; HttpOnly; SameSite=Lax" +
          secure,
      );
    }
    if (!authorizationId) {
      res.status(400).send("Missing or expired authorization request");
      return;
    }
    render(res, { authorizationId, config, mode: "consent" });
  });

  app.get("/auth/callback", (req, res) => {
    const authorizationId = authorizationFromRequest(req, config.cookieSecret);
    if (!authorizationId) {
      res.status(400).send("Missing or expired authorization request");
      return;
    }
    render(res, { authorizationId, config, mode: "callback" });
  });

  app.get("/auth/activate", (_req, res) => {
    render(res, { authorizationId: "", config, mode: "activate" });
  });
}
