import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createTokenVerifier } from "../../src/server/auth.mjs";

const identity = {
  principalType: "user",
  userId: "11111111-1111-4111-8111-111111111111",
  username: "tester",
  projectId: "22222222-2222-4222-8222-222222222222",
  projectAlias: "synapse",
  oauthClientId: "client-1",
  authMethod: "oauth",
};

function configuration(overrides = {}) {
  return {
    allowDevTokens: false,
    requiredScopes: ["openid", "email", "profile"],
    resourceUrl: new URL("https://memory.example.com/mcp"),
    supabaseIssuer: "https://example.supabase.co/auth/v1",
    supabaseJwksUrl: new URL(
      "https://example.supabase.co/auth/v1/.well-known/jwks.json",
    ),
    ...overrides,
  };
}

test("OAuth access tokens resolve to a user principal, not a session principal", async () => {
  const calls = [];
  const database = {
    async resolveIdentity(userId, attribution) {
      calls.push({ userId, attribution });
      return identity;
    },
  };
  const verifier = createTokenVerifier(configuration(), database, {
    verifyJwt: async () => ({
      payload: {
        sub: identity.userId,
        client_id: "client-1",
        scope: "openid email profile",
        exp: 2_000_000_000,
      },
    }),
  });
  const auth = await verifier.verifyAccessToken("signed.jwt");
  assert.equal(auth.clientId, "client-1");
  assert.deepEqual(auth.scopes, ["openid", "email", "profile"]);
  assert.equal(auth.extra.identity, identity);
  assert.deepEqual(calls, [
    {
      userId: identity.userId,
      attribution: { authMethod: "oauth", oauthClientId: "client-1" },
    },
  ]);
});

test("OAuth tokens without client attribution are rejected", async () => {
  const verifier = createTokenVerifier(
    configuration(),
    {},
    {
      verifyJwt: async () => ({
        payload: { sub: identity.userId, exp: 2_000_000_000 },
      }),
    },
  );
  await assert.rejects(
    verifier.verifyAccessToken("signed.jwt"),
    /OAuth client_id is missing/,
  );
});

test("insufficient scopes are rejected before identity activation", async () => {
  let identityLookups = 0;
  const verifier = createTokenVerifier(
    configuration(),
    {
      async resolveIdentity() {
        identityLookups += 1;
      },
    },
    {
      verifyJwt: async () => ({
        payload: {
          sub: identity.userId,
          client_id: "client-1",
          scope: "openid",
          exp: 2_000_000_000,
        },
      }),
    },
  );
  await assert.rejects(
    verifier.verifyAccessToken("signed.jwt"),
    /missing required scopes: email, profile/,
  );
  assert.equal(identityLookups, 0);
});

test("development tokens are disabled by default and hashed before lookup", async () => {
  const raw = "syn_dev_example";
  const seen = [];
  const database = {
    async exchangeDevelopmentToken(hash) {
      seen.push(hash);
      return { owner_id: identity.userId, expires_at: "2030-01-01T00:00:00Z" };
    },
    async resolveIdentity() {
      return { ...identity, authMethod: "development_token" };
    },
  };
  await assert.rejects(
    createTokenVerifier(configuration(), database).verifyAccessToken(raw),
    /disabled/,
  );
  const auth = await createTokenVerifier(
    configuration({ allowDevTokens: true }),
    database,
  ).verifyAccessToken(raw);
  assert.deepEqual(seen[0], createHash("sha256").update(raw).digest());
  assert.equal(auth.clientId, "synapse-development-token");
  assert.equal(auth.extra.identity.authMethod, "development_token");
});
