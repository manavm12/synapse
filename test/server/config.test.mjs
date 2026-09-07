import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/server/config.mjs";

function environment(overrides = {}) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://runtime:secret@127.0.0.1/synapse",
    DATABASE_SSL: "disable",
    MCP_RESOURCE_URL: "http://127.0.0.1:8787/mcp",
    SUPABASE_URL: "https://example.supabase.co/",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
    COOKIE_SIGNING_SECRET: "x".repeat(32),
    ...overrides,
  };
}

test("configuration derives an exact OAuth resource and Supabase issuer", () => {
  const config = loadConfig(environment());
  assert.equal(config.resourceUrl.href, "http://127.0.0.1:8787/mcp");
  assert.equal(
    config.resourceMetadataUrl.href,
    "http://127.0.0.1:8787/.well-known/oauth-protected-resource",
  );
  assert.equal(config.supabaseIssuer, "https://example.supabase.co/auth/v1");
  assert.equal(
    config.supabaseJwksUrl.href,
    "https://example.supabase.co/auth/v1/.well-known/jwks.json",
  );
  assert.deepEqual(config.requiredScopes, ["openid", "email", "profile"]);
  assert.equal(config.databaseSsl, false);
  assert.equal(config.publicSignup, false);
  assert.equal(config.trustedProxyHops, 0);
});

test("public signup is explicit and boolean", () => {
  assert.equal(
    loadConfig(environment({ PUBLIC_SIGNUP_ENABLED: "true" })).publicSignup,
    true,
  );
  assert.throws(
    () => loadConfig(environment({ PUBLIC_SIGNUP_ENABLED: "yes" })),
    /must be true or false/,
  );
});

test("trusted proxy hops are explicit and bounded", () => {
  assert.equal(
    loadConfig(environment({ TRUST_PROXY_HOPS: "1" })).trustedProxyHops,
    1,
  );
  assert.throws(
    () => loadConfig(environment({ TRUST_PROXY_HOPS: "all" })),
    /TRUST_PROXY_HOPS must be an integer/,
  );
  assert.throws(
    () => loadConfig(environment({ TRUST_PROXY_HOPS: "11" })),
    /TRUST_PROXY_HOPS must be an integer/,
  );
});

test("database TLS verifies the server and accepts a multiline CA", () => {
  const config = loadConfig(
    environment({
      DATABASE_SSL: "verify-full",
      DATABASE_CA_CERT: "certificate-line-1\\ncertificate-line-2",
    }),
  );
  assert.deepEqual(config.databaseSsl, {
    rejectUnauthorized: true,
    ca: "certificate-line-1\ncertificate-line-2",
  });
});

test("production rejects insecure or inexact service URLs", () => {
  assert.throws(
    () => loadConfig(environment({ NODE_ENV: "production" })),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig(
        environment({ MCP_RESOURCE_URL: "https://memory.example.com/mcp/" }),
      ),
    /exactly in \/mcp/,
  );
  assert.throws(
    () => loadConfig(environment({ COOKIE_SIGNING_SECRET: "short" })),
    /at least 32/,
  );
  assert.throws(
    () =>
      loadConfig(
        environment({
          NODE_ENV: "production",
          MCP_RESOURCE_URL: "https://memory.example.com/mcp",
        }),
      ),
    /DATABASE_SSL=verify-full/,
  );
});
