import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  createMcpExpressApp,
  requireBearerAuth,
} from "@modelcontextprotocol/express";

import { installConsentRoutes } from "./consent.mjs";
import { installInboxRoutes } from "./inbox.mjs";
import { createMcpRuntime } from "./mcp.mjs";
import { installReceiverRoutes } from "./messaging/receiver.mjs";
import { installOnboardingRoutes } from "./onboarding.mjs";

function supabaseBrowserPath() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@supabase/supabase-js");
  return join(dirname(entry), "umd", "supabase.js");
}

function publicMetadata(config) {
  return {
    resource: config.resourceUrl.href,
    authorization_servers: [config.supabaseIssuer],
    scopes_supported: config.requiredScopes,
    bearer_methods_supported: ["header"],
    resource_name: "Synapse Memory",
  };
}

export async function createApplication({
  config,
  database,
  verifier,
  sessionVerifier,
  logger,
  memoryRetrieval,
  fetchImplementation = fetch,
}) {
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedHosts,
    jsonLimit: "80kb",
  });
  if (config.trustedProxyHops > 0) {
    app.set("trust proxy", config.trustedProxyHops);
  }
  const runtime = await createMcpRuntime({
    config,
    database,
    logger,
    memoryRetrieval,
  });

  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set("X-Request-ID", req.requestId);
    const started = performance.now();
    res.on("finish", () => {
      logger.info("http_request", {
        request_id: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        latency_ms: Math.round(performance.now() - started),
        mcp_method:
          req.path === "/mcp" && typeof req.body?.method === "string"
            ? req.body.method
            : null,
      });
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    let stage = "database";
    try {
      await database.healthCheck();
      stage = "jwks";
      const response = await fetchImplementation(config.supabaseJwksUrl, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error("JWKS is unavailable");
      const body = await response.json();
      if (!Array.isArray(body.keys) || body.keys.length === 0) {
        throw new Error("JWKS has no signing keys");
      }
      res.json({ status: "ready" });
    } catch (error) {
      logger.error("readiness_check_failed", {
        stage,
        error_type: error?.name ?? "Error",
        error_code:
          typeof error?.code === "string" || typeof error?.code === "number"
            ? String(error.code)
            : null,
      });
      res.status(503).json({ status: "not_ready" });
    }
  });

  const metadata = publicMetadata(config);
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    app.get(path, (_req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "public, max-age=300");
      res.json(metadata);
    });
    app.options(path, (_req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.status(204).end();
    });
  }

  installConsentRoutes(app, config, {
    database,
    sessionVerifier,
    supabaseBrowserPath: supabaseBrowserPath(),
  });
  installOnboardingRoutes(app, config, {
    database,
    sessionVerifier,
    logger,
  });
  installReceiverRoutes(app, config, {
    database,
    sessionVerifier,
    logger,
  });
  installInboxRoutes(app, config, {
    database,
    sessionVerifier,
    logger,
  });

  const authenticate = requireBearerAuth({
    verifier,
    requiredScopes: config.requiredScopes,
    resourceMetadataUrl: config.resourceMetadataUrl.href,
  });
  app.post("/mcp", authenticate, async (req, res) => {
    req.auth.extra = {
      ...(req.auth.extra ?? {}),
      requestId: req.requestId,
    };
    try {
      await runtime.transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("mcp_transport", {
        request_id: req.requestId,
        error_type: error.name,
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          id: req.body?.id ?? null,
          error: { code: -32603, message: "Internal error" },
        });
      }
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use((error, req, res, _next) => {
    logger.error("http_error", {
      request_id: req.requestId ?? null,
      error_type: error.name,
    });
    if (!res.headersSent) res.status(400).json({ error: "invalid_request" });
  });

  return { app, ...runtime };
}
