import { databaseSsl } from "../database-ssl.mjs";

const REQUIRED_SCOPES = Object.freeze(["openid", "email", "profile"]);

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function booleanEnv(value, defaultValue = false) {
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Boolean environment values must be true or false");
}

function serviceUrl(value, { production, exactPath }) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (production && url.protocol !== "https:") {
    throw new Error("Production service URLs must use HTTPS");
  }
  if (
    !production &&
    url.protocol !== "https:" &&
    !(local && url.protocol === "http:")
  ) {
    throw new Error("Service URLs must use HTTPS or local HTTP");
  }
  if (url.pathname !== exactPath || url.search || url.hash) {
    throw new Error(`Service URL must end exactly in ${exactPath}`);
  }
  return url;
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const resourceUrl = serviceUrl(required(env, "MCP_RESOURCE_URL"), {
    production,
    exactPath: "/mcp",
  });
  const supabaseUrl = serviceUrl(required(env, "SUPABASE_URL"), {
    production,
    exactPath: "/",
  });
  const cookieSecret = required(env, "COOKIE_SIGNING_SECRET");
  if (cookieSecret.length < 32) {
    throw new Error(
      "COOKIE_SIGNING_SECRET must contain at least 32 characters",
    );
  }
  const port = Number(env.PORT ?? 8787);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be a valid TCP port");
  }
  const ssl = databaseSsl(env);
  if (production && (ssl === false || !ssl.ca)) {
    throw new Error(
      "Production requires DATABASE_SSL=verify-full and DATABASE_CA_CERT",
    );
  }
  return Object.freeze({
    production,
    port,
    databaseUrl: required(env, "DATABASE_URL"),
    databaseSsl: ssl,
    resourceUrl,
    resourceMetadataUrl: new URL(
      "/.well-known/oauth-protected-resource",
      resourceUrl,
    ),
    supabaseUrl,
    supabaseIssuer: new URL("/auth/v1", supabaseUrl).href.replace(/\/$/, ""),
    supabaseJwksUrl: new URL("/auth/v1/.well-known/jwks.json", supabaseUrl),
    supabasePublishableKey: required(env, "SUPABASE_PUBLISHABLE_KEY"),
    cookieSecret,
    allowDevTokens: booleanEnv(env.ALLOW_DEV_TOKENS),
    requiredScopes: REQUIRED_SCOPES,
    allowedHosts: [
      resourceUrl.hostname,
      "healthcheck.railway.app",
      "localhost",
      "127.0.0.1",
      "[::1]",
    ],
  });
}
