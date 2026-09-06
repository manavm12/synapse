import { createHash } from "node:crypto";

import pg from "pg";

export class MemoryConflictError extends Error {
  constructor(message = "capture_id was already used with different content") {
    super(message);
    this.name = "MemoryConflictError";
  }
}

export class UsernameTakenError extends Error {
  constructor(message = "username is already taken") {
    super(message);
    this.name = "UsernameTakenError";
  }
}

export class AccountDisabledError extends Error {
  constructor(message = "Synapse account is disabled") {
    super(message);
    this.name = "AccountDisabledError";
  }
}

function contentHash(input) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        captureId: input.captureId,
        sessionId: input.sessionId,
        projectAlias: input.projectAlias,
        captureReason: input.captureReason,
        title: input.title,
        summary: input.summary,
        markdown: input.markdown,
      }),
    )
    .digest("hex");
}

export function createDatabase(config) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  async function withUser(userId, operation) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("select set_config('app.current_user_id', $1, true)", [
        userId,
      ]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function resolveIdentity(userId, { authMethod, oauthClientId }) {
    return withUser(userId, async (client) => {
      await client.query(
        `update public.profiles
         set status = 'active'
         where id = $1 and status = 'invited'`,
        [userId],
      );
      const result = await client.query(
        `select
           profile.id as user_id,
           profile.username::text,
           project.id as project_id,
           project.alias::text as project_alias
         from public.profiles as profile
         join public.projects as project on project.owner_id = profile.id
         where profile.id = $1 and profile.status = 'active'`,
        [userId],
      );
      if (result.rowCount !== 1) {
        throw new Error("Synapse identity is inactive or has no project");
      }
      const row = result.rows[0];
      return {
        principalType: "user",
        userId: row.user_id,
        username: row.username,
        projectId: row.project_id,
        projectAlias: row.project_alias,
        oauthClientId,
        authMethod,
      };
    });
  }

  async function getAccount(userId) {
    return withUser(userId, async (client) => {
      const result = await client.query(
        `select
           profile.username::text,
           profile.status::text,
           project.id as project_id,
           project.alias::text as project_alias
         from public.profiles as profile
         left join public.projects as project on project.owner_id = profile.id
         where profile.id = $1`,
        [userId],
      );
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      if (row.status === "disabled") throw new AccountDisabledError();
      if (!row.project_id) return null;
      return {
        username: row.username,
        projectId: row.project_id,
        projectAlias: row.project_alias,
      };
    });
  }

  async function registerAccount(userId, { username, projectAlias }) {
    try {
      return await withUser(userId, async (client) => {
        const result = await client.query(
          `select account_id, account_username, account_status,
                  project_id, project_alias
           from synapse_private.register_identity($1, $2)`,
          [username, projectAlias],
        );
        if (result.rowCount !== 1) {
          throw new Error("Synapse account provisioning returned no identity");
        }
        const row = result.rows[0];
        return {
          username: row.account_username,
          projectId: row.project_id,
          projectAlias: row.project_alias,
        };
      });
    } catch (error) {
      if (
        error?.code === "23505" &&
        error?.constraint === "profiles_username_key"
      ) {
        throw new UsernameTakenError();
      }
      if (error?.code === "42501") throw new AccountDisabledError();
      throw error;
    }
  }

  async function exchangeDevelopmentToken(tokenHash) {
    const result = await pool.query(
      `select owner_id, expires_at
       from synapse_private.authenticate_development_token($1)`,
      [tokenHash],
    );
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async function saveSessionMemory(identity, input, requestId) {
    const hash = contentHash(input);
    const result = await withUser(identity.userId, async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [input.captureId],
      );
      const projectResult = await client.query(
        `select id, alias::text
         from public.projects
         where owner_id = $1 and alias = $2`,
        [identity.userId, input.projectAlias],
      );
      if (projectResult.rowCount !== 1) {
        throw new Error(
          "project_alias does not match the authenticated identity",
        );
      }
      const project = projectResult.rows[0];
      const sessionResult = await client.query(
        `insert into public.agent_sessions (
           owner_id, project_id, client_session_id, runtime,
           oauth_client_id, auth_method
         ) values ($1, $2, $3, 'codex', $4, $5)
         on conflict (owner_id, client_session_id) do update set
           project_id = excluded.project_id,
           oauth_client_id = excluded.oauth_client_id,
           auth_method = excluded.auth_method,
           last_seen_at = now()
         returning id`,
        [
          identity.userId,
          project.id,
          input.sessionId,
          identity.oauthClientId,
          identity.authMethod,
        ],
      );
      const agentSessionId = sessionResult.rows[0].id;
      const existingResult = await client.query(
        `select node_id, revision, content_hash, created_at
         from public.memory_revisions
         where capture_id = $1`,
        [input.captureId],
      );
      if (existingResult.rowCount === 1) {
        const existing = existingResult.rows[0];
        if (existing.content_hash === hash) {
          return {
            saved: true,
            idempotent: true,
            nodeId: existing.node_id,
            sessionId: input.sessionId,
            revision: existing.revision,
            contentHash: existing.content_hash,
            savedAt: existing.created_at,
          };
        }
        await client.query(
          `insert into public.audit_events (
             owner_id, actor_session_id, oauth_client_id, action,
             target_type, target_id, request_id, metadata
           ) values ($1, $2, $3, 'memory.capture_conflict',
             'memory_node', $4, $5, $6::jsonb)`,
          [
            identity.userId,
            agentSessionId,
            identity.oauthClientId,
            existing.node_id,
            requestId,
            JSON.stringify({
              capture_id: input.captureId,
              existing_content_hash: existing.content_hash,
              attempted_content_hash: hash,
            }),
          ],
        );
        return { conflict: true };
      }

      const rootResult = await client.query(
        `select id from public.memory_nodes
         where project_id = $1 and kind = 'root'`,
        [project.id],
      );
      if (rootResult.rowCount !== 1)
        throw new Error("Project memory root is missing");

      await client.query(
        `insert into public.memory_nodes (
           owner_id, project_id, parent_node_id, kind, source_session_id,
           title, summary, markdown
         ) values ($1, $2, $3, 'session', $4, $5, $6, $7)
         on conflict (project_id, source_session_id)
           where kind = 'session'
         do nothing`,
        [
          identity.userId,
          project.id,
          rootResult.rows[0].id,
          input.sessionId,
          input.title,
          input.summary,
          input.markdown,
        ],
      );
      const nodeResult = await client.query(
        `select id, revision from public.memory_nodes
         where project_id = $1 and source_session_id = $2 and kind = 'session'
         for update`,
        [project.id, input.sessionId],
      );
      if (nodeResult.rowCount !== 1)
        throw new Error("Session memory node is missing");
      const node = nodeResult.rows[0];
      const revision = Number(node.revision) + 1;
      const revisionResult = await client.query(
        `insert into public.memory_revisions (
           owner_id, project_id, node_id, author_session_id,
           capture_id, capture_reason, revision, title, summary,
           markdown, content_hash
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning created_at`,
        [
          identity.userId,
          project.id,
          node.id,
          agentSessionId,
          input.captureId,
          input.captureReason,
          revision,
          input.title,
          input.summary,
          input.markdown,
          hash,
        ],
      );
      await client.query(
        `update public.memory_nodes
         set title = $2, summary = $3, markdown = $4,
             revision = $5, content_hash = $6
         where id = $1`,
        [node.id, input.title, input.summary, input.markdown, revision, hash],
      );
      await client.query(
        `insert into public.audit_events (
           owner_id, actor_session_id, oauth_client_id, action,
           target_type, target_id, request_id, metadata
         ) values ($1, $2, $3, 'memory.saved',
           'memory_node', $4, $5, $6::jsonb)`,
        [
          identity.userId,
          agentSessionId,
          identity.oauthClientId,
          node.id,
          requestId,
          JSON.stringify({
            capture_id: input.captureId,
            capture_reason: input.captureReason,
            revision,
            content_hash: hash,
          }),
        ],
      );
      return {
        saved: true,
        idempotent: false,
        nodeId: node.id,
        sessionId: input.sessionId,
        revision,
        contentHash: hash,
        savedAt: revisionResult.rows[0].created_at,
      };
    });
    if (result.conflict) throw new MemoryConflictError();
    return result;
  }

  return {
    resolveIdentity,
    getAccount,
    registerAccount,
    exchangeDevelopmentToken,
    saveSessionMemory,
    async healthCheck() {
      await pool.query("select 1");
    },
    async close() {
      await pool.end();
    },
  };
}
