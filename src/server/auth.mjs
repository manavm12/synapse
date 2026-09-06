import { createHash } from "node:crypto";

import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

function scopesFrom(payload) {
  const raw = payload.scope ?? payload.scopes ?? "";
  if (Array.isArray(raw))
    return raw.filter((scope) => typeof scope === "string");
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  return [];
}

function invalidToken(message) {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

function requireScopes(scopes, requiredScopes) {
  const available = new Set(scopes);
  const missing = requiredScopes.filter((scope) => !available.has(scope));
  if (missing.length > 0) {
    throw new OAuthError(
      OAuthErrorCode.InsufficientScope,
      `Access token is missing required scopes: ${missing.join(", ")}`,
    );
  }
}

export function createTokenVerifier(
  config,
  database,
  { verifyJwt, jwks = createRemoteJWKSet(config.supabaseJwksUrl) } = {},
) {
  const verify =
    verifyJwt ??
    ((token) =>
      jwtVerify(token, jwks, {
        issuer: config.supabaseIssuer,
        audience: config.resourceUrl.href,
        clockTolerance: 5,
      }));

  return {
    async verifyAccessToken(token) {
      try {
        if (token.startsWith("syn_dev_")) {
          if (!config.allowDevTokens)
            throw invalidToken("Development tokens are disabled");
          const tokenHash = createHash("sha256").update(token).digest();
          const exchanged = await database.exchangeDevelopmentToken(tokenHash);
          if (!exchanged) throw invalidToken("Development token is invalid");
          const identity = await database.resolveIdentity(exchanged.owner_id, {
            authMethod: "development_token",
            oauthClientId: "synapse-development-token",
          });
          return {
            token,
            clientId: "synapse-development-token",
            scopes: [...config.requiredScopes],
            expiresAt: Math.floor(
              new Date(exchanged.expires_at).getTime() / 1000,
            ),
            resource: config.resourceUrl,
            extra: { identity },
          };
        }

        const { payload } = await verify(token);
        if (typeof payload.sub !== "string")
          throw invalidToken("Token subject is missing");
        if (typeof payload.client_id !== "string" || !payload.client_id) {
          throw invalidToken("OAuth client_id is missing");
        }
        if (typeof payload.exp !== "number")
          throw invalidToken("Token expiry is missing");
        const scopes = scopesFrom(payload);
        requireScopes(scopes, config.requiredScopes);
        const identity = await database.resolveIdentity(payload.sub, {
          authMethod: "oauth",
          oauthClientId: payload.client_id,
        });
        return {
          token,
          clientId: payload.client_id,
          scopes,
          expiresAt: payload.exp,
          resource: config.resourceUrl,
          extra: { identity },
        };
      } catch (error) {
        if (OAuthError.isInstance(error)) throw error;
        throw invalidToken(
          "Access token is invalid or the identity is inactive",
        );
      }
    },
  };
}
