import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { PROJECT_ALIAS_PATTERN } from "./client/project-registry.mjs";
import { databaseConnectionOptions, databaseSsl } from "./database-ssl.mjs";

const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{2,31}$/;

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeEmail(value) {
  const email = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid email address is required");
  }
  return email;
}

function normalizeUsername(value) {
  const username = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      "Username must be 3-32 lowercase characters starting with a letter",
    );
  }
  return username;
}

function normalizeProjectAlias(value) {
  const alias = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!PROJECT_ALIAS_PATTERN.test(alias)) {
    throw new Error(
      "Project alias must be 2-63 lowercase characters starting with a letter",
    );
  }
  return alias;
}

function adminPool(env) {
  return new pg.Pool(
    databaseConnectionOptions({
      connectionString: requiredEnv(env, "DATABASE_ADMIN_URL"),
      max: 1,
      ssl: databaseSsl(env),
    }),
  );
}

function supabaseAdmin(env) {
  return createClient(
    requiredEnv(env, "SUPABASE_URL"),
    requiredEnv(env, "SUPABASE_SECRET_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function activationUrl(env) {
  const resource = new URL(requiredEnv(env, "MCP_RESOURCE_URL"));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(resource.hostname);
  if (
    (resource.protocol !== "https:" &&
      !(local && resource.protocol === "http:")) ||
    resource.pathname !== "/mcp" ||
    resource.search ||
    resource.hash
  ) {
    throw new Error("MCP_RESOURCE_URL must end exactly in /mcp");
  }
  return new URL("/auth/activate", resource).href;
}

export async function inviteUser(
  { email, username, projectAlias },
  dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const ownsPool = !dependencies.pool;
  const pool = dependencies.pool ?? adminPool(env);
  const auth = dependencies.auth ?? supabaseAdmin(env);
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);
  const normalizedProjectAlias = normalizeProjectAlias(projectAlias);
  const inviteId = randomUUID();
  let userId;
  try {
    const reserved = await pool.query(
      `INSERT INTO public.invites (
         id, normalized_email, reserved_username, reserved_project_alias,
         status, expires_at
       ) VALUES ($1, $2, $3, $4, 'pending', now() + interval '7 days')
       ON CONFLICT (normalized_email) DO UPDATE SET
         reserved_username = excluded.reserved_username,
         reserved_project_alias = excluded.reserved_project_alias,
         status = 'pending',
         expires_at = excluded.expires_at,
         error_message = null,
         updated_at = now()
       WHERE public.invites.status IN ('failed', 'expired')
       RETURNING id, user_id`,
      [inviteId, normalizedEmail, normalizedUsername, normalizedProjectAlias],
    );
    if (reserved.rowCount !== 1) {
      throw new Error("An active invite already exists for this email");
    }

    userId = reserved.rows[0].user_id;
    if (!userId) {
      const { data, error } = await auth.auth.admin.inviteUserByEmail(
        normalizedEmail,
        {
          redirectTo: activationUrl(env),
          data: {
            username: normalizedUsername,
            project_alias: normalizedProjectAlias,
          },
        },
      );
      if (error || !data.user?.id) {
        await pool.query(
          `UPDATE public.invites
           SET status = 'failed', error_message = $2, updated_at = now()
           WHERE normalized_email = $1`,
          [normalizedEmail, error?.message ?? "Supabase did not return a user"],
        );
        throw new Error(error?.message ?? "Supabase invite failed");
      }
      userId = data.user.id;
      await pool.query(
        `UPDATE public.invites
         SET user_id = $2, error_message = null, updated_at = now()
         WHERE normalized_email = $1`,
        [normalizedEmail, userId],
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO public.profiles (id, username, email, status)
         VALUES ($1, $2, $3, 'invited')
         ON CONFLICT (id) DO UPDATE SET
           username = excluded.username,
           email = excluded.email,
           status = CASE
             WHEN public.profiles.status = 'disabled' THEN 'disabled'
             ELSE public.profiles.status
           END`,
        [userId, normalizedUsername, normalizedEmail],
      );
      const project = await client.query(
        `INSERT INTO public.projects (owner_id, alias, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (owner_id) DO UPDATE SET
           alias = excluded.alias,
           display_name = excluded.display_name,
           updated_at = now()
         RETURNING id, alias`,
        [userId, normalizedProjectAlias, normalizedProjectAlias],
      );
      await client.query(
        `UPDATE public.invites
         SET user_id = $2, status = 'sent', error_message = null, updated_at = now()
         WHERE normalized_email = $1`,
        [normalizedEmail, userId],
      );
      await client.query("COMMIT");
      return {
        invited: true,
        userId,
        username: normalizedUsername,
        email: normalizedEmail,
        projectId: project.rows[0].id,
        projectAlias: project.rows[0].alias,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      await client.query(
        `UPDATE public.invites
         SET status = 'failed', error_message = $2, updated_at = now()
         WHERE normalized_email = $1`,
        [normalizedEmail, error.message],
      );
      throw error;
    } finally {
      client.release();
    }
  } finally {
    if (ownsPool) await pool.end();
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest();
}

export async function createDevelopmentToken(
  { username, expiresInDays = 7, label = "local-development" },
  dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const ownsPool = !dependencies.pool;
  const pool = dependencies.pool ?? adminPool(env);
  const random = dependencies.random ?? randomBytes;
  const normalizedUsername = normalizeUsername(username);
  const days = Number(expiresInDays);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error("Token expiry must be from 1 to 365 days");
  }
  const rawToken = `syn_dev_${random(32).toString("base64url")}`;
  try {
    const result = await pool.query(
      `INSERT INTO public.development_tokens (
         owner_id, label, token_prefix, token_hash, expires_at
       )
       SELECT id, $2, $3, $4, now() + ($5::text || ' days')::interval
       FROM public.profiles
       WHERE username = $1 AND status <> 'disabled'
       RETURNING id, owner_id, expires_at`,
      [
        normalizedUsername,
        String(label).slice(0, 100),
        rawToken.slice(0, 16),
        hashToken(rawToken),
        days,
      ],
    );
    if (result.rowCount !== 1) throw new Error("Active user not found");
    return {
      tokenId: result.rows[0].id,
      ownerId: result.rows[0].owner_id,
      token: rawToken,
      expiresAt: result.rows[0].expires_at,
    };
  } finally {
    if (ownsPool) await pool.end();
  }
}

export async function revokeDevelopmentToken({ tokenId }, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const ownsPool = !dependencies.pool;
  const pool = dependencies.pool ?? adminPool(env);
  try {
    const result = await pool.query(
      `UPDATE public.development_tokens
       SET revoked_at = coalesce(revoked_at, now())
       WHERE id = $1
       RETURNING id, revoked_at`,
      [tokenId],
    );
    if (result.rowCount !== 1) throw new Error("Development token not found");
    return { tokenId: result.rows[0].id, revokedAt: result.rows[0].revoked_at };
  } finally {
    if (ownsPool) await pool.end();
  }
}

export async function configureMcpResource({ mcpUrl }, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const ownsPool = !dependencies.pool;
  const pool = dependencies.pool ?? adminPool(env);
  const url = new URL(mcpUrl);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/mcp" ||
    url.search ||
    url.hash
  ) {
    throw new Error("MCP resource must be an HTTPS URL ending exactly in /mcp");
  }
  try {
    await pool.query(
      `INSERT INTO public.app_config (key, value, updated_at)
       VALUES ('mcp_resource_url', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [url.href],
    );
    return { mcpResourceUrl: url.href };
  } finally {
    if (ownsPool) await pool.end();
  }
}

export async function rotateRuntimeRole(_input = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const ownsPool = !dependencies.pool;
  const pool = dependencies.pool ?? adminPool(env);
  const random = dependencies.random ?? randomBytes;
  const password = random(32).toString("base64url");
  const escaped = password.replaceAll("'", "''");
  try {
    await pool.query(
      `ALTER ROLE synapse_runtime WITH LOGIN PASSWORD '${escaped}'`,
    );
    return { role: "synapse_runtime", password };
  } finally {
    if (ownsPool) await pool.end();
  }
}
