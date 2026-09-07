import { createHash } from "node:crypto";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createMemorySourceReader({ pool }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A Postgres pool is required");
  }
  return {
    async read({ ownerId, projectId, revisionId }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query(
          "select set_config('app.current_user_id', $1, true)",
          [ownerId],
        );
        await client.query(
          "select set_config('app.current_project_id', $1, true)",
          [projectId],
        );
        const result = await client.query(
          `select
             revision.id as revision_id,
             revision.owner_id,
             revision.project_id,
             revision.node_id,
             session.client_session_id,
             revision.revision,
             revision.title,
             revision.summary,
             revision.markdown,
             revision.content_hash as capture_content_hash,
             revision.created_at
           from public.memory_revisions as revision
           join public.agent_sessions as session
             on session.id = revision.author_session_id
            and session.owner_id = revision.owner_id
            and session.project_id = revision.project_id
           where revision.id = $1
             and revision.owner_id = $2
             and revision.project_id = $3`,
          [revisionId, ownerId, projectId],
        );
        await client.query("COMMIT");
        if (result.rowCount !== 1) return null;
        const row = result.rows[0];
        return {
          ownerId: row.owner_id,
          projectId: row.project_id,
          revisionId: row.revision_id,
          nodeId: row.node_id,
          sessionId: row.client_session_id,
          revision: row.revision,
          title: row.title,
          summary: row.summary,
          markdown: row.markdown,
          contentHash: hash(row.markdown),
          captureContentHash: row.capture_content_hash,
          capturedAt: new Date(row.created_at).toISOString(),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
