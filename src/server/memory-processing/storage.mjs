import pg from "pg";

import { databaseConnectionOptions } from "../../database-ssl.mjs";

export class MemoryProcessingLeaseLostError extends Error {
  constructor(message = "memory processing lease is no longer valid") {
    super(message);
    this.name = "MemoryProcessingLeaseLostError";
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function boundedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4000);
}

function jobFromRow(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    revisionId: row.revision_id,
    processorVersion: Number(row.processor_version),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseToken: row.lease_token,
    leaseFence: row.lease_fence,
    leaseExpiresAt: row.lease_expires_at,
    source: {
      version: 1,
      ownerId: row.owner_id,
      projectId: row.project_id,
      revisionId: row.revision_id,
      nodeId: row.node_id,
      sessionId: row.client_session_id,
      revision: Number(row.revision),
      captureId: row.capture_id,
      title: row.title,
      summary: row.summary,
      markdown: row.markdown,
      capturedAt: row.captured_at.toISOString(),
    },
  };
}

const claimableJobsSql = `
  select job.id, job.project_id
  from synapse_private.memory_processing_jobs as job
  join public.memory_revisions as revision on
    revision.id = job.revision_id
    and revision.owner_id = job.owner_id
    and revision.project_id = job.project_id
  where job.status = 'pending'
    and job.processor_version = $1
    and job.available_at <= $2
    and job.attempt_count < job.max_attempts
    and not exists (
      select 1
      from synapse_private.memory_processing_jobs as earlier_job
      join public.memory_revisions as earlier_revision on
        earlier_revision.id = earlier_job.revision_id
      where earlier_job.processor_version = job.processor_version
        and earlier_revision.node_id = revision.node_id
        and earlier_revision.revision < revision.revision
        and earlier_job.status <> 'succeeded'
    )`;

export function createMemoryProcessingStorage({
  databaseUrl,
  databaseSsl,
  pool: suppliedPool,
  retryDelay = (attempt) => Math.min(60_000, 1_000 * 2 ** (attempt - 1)),
}) {
  const ownsPool = !suppliedPool;
  const pool =
    suppliedPool ??
    new pg.Pool(
      databaseConnectionOptions({
        connectionString: databaseUrl,
        ssl: databaseSsl,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      }),
    );

  async function transaction(operation) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async function releaseProjectLease(client, job) {
    await client.query(
      `update synapse_private.memory_processing_project_leases
       set lease_token = null, leased_by = null, lease_expires_at = null
       where project_id = $1 and fence = $2 and lease_token = $3`,
      [job.projectId, job.leaseFence, job.leaseToken],
    );
  }

  async function recoverExpired(now) {
    const candidates = await transaction((client) =>
      client.query(
        `select id, project_id
         from synapse_private.memory_processing_jobs
         where status = 'processing' and lease_expires_at <= $1
         order by lease_expires_at, created_at`,
        [now],
      ),
    );
    let recovered = 0;
    for (const candidate of candidates.rows) {
      recovered += await transaction(async (client) => {
        // Every queue transaction locks one project first, then its job.
        // Skip a project being renewed or completed, and recheck expiration
        // after locking: the candidate scan is only a scheduling hint.
        const project = await client.query(
          `select project_id
           from synapse_private.memory_processing_project_leases
           where project_id = $1
           for update skip locked`,
          [candidate.project_id],
        );
        if (project.rowCount !== 1) return 0;
        const expired = await client.query(
          `select id, project_id, attempt_count, max_attempts,
                  lease_token, lease_fence
           from synapse_private.memory_processing_jobs
           where id = $1 and project_id = $2
             and status = 'processing' and lease_expires_at <= $3
           for update`,
          [candidate.id, candidate.project_id, now],
        );
        if (expired.rowCount !== 1) return 0;
        const row = expired.rows[0];
        const failed = Number(row.attempt_count) >= Number(row.max_attempts);
        const availableAt = new Date(
          now.getTime() + retryDelay(Number(row.attempt_count)),
        );
        await client.query(
          `update synapse_private.memory_processing_jobs
           set status = $2, available_at = $3,
               leased_by = null, lease_token = null, lease_fence = null,
               lease_expires_at = null,
               last_error = 'worker lease expired before completion'
           where id = $1`,
          [row.id, failed ? "failed" : "pending", availableAt],
        );
        await releaseProjectLease(client, {
          projectId: row.project_id,
          leaseFence: row.lease_fence,
          leaseToken: row.lease_token,
        });
        return 1;
      });
    }
    return recovered;
  }

  async function claimNext({
    workerId,
    processorVersion = 1,
    leaseDurationMs = 30_000,
    now = new Date(),
  }) {
    if (
      typeof workerId !== "string" ||
      workerId.length < 1 ||
      workerId.length > 200
    ) {
      throw new TypeError("workerId must contain 1 to 200 characters");
    }
    requirePositiveInteger(processorVersion, "processorVersion");
    requirePositiveInteger(leaseDurationMs, "leaseDurationMs");
    await recoverExpired(now);
    const candidates = await transaction((client) =>
      client.query(
        `${claimableJobsSql}
           and not exists (
             select 1
             from synapse_private.memory_processing_project_leases as lease
             where lease.project_id = job.project_id
               and lease.lease_token is not null
               and lease.lease_expires_at > $2
           )
         order by job.available_at, revision.created_at, revision.revision
         limit 50`,
        [processorVersion, now],
      ),
    );
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    for (const candidate of candidates.rows) {
      const job = await transaction(async (client) => {
        // Do not retain locks across candidates from different projects.
        const lease = await client.query(
          `insert into synapse_private.memory_processing_project_leases (
             project_id, fence, lease_token, leased_by, lease_expires_at
           ) values ($1, 1, gen_random_uuid(), $2, $3)
           on conflict (project_id) do update set
             fence = synapse_private.memory_processing_project_leases.fence + 1,
             lease_token = gen_random_uuid(),
             leased_by = excluded.leased_by,
             lease_expires_at = excluded.lease_expires_at
           where synapse_private.memory_processing_project_leases.lease_token is null
              or synapse_private.memory_processing_project_leases.lease_expires_at <= $4
           returning fence, lease_token`,
          [candidate.project_id, workerId, expiresAt, now],
        );
        if (lease.rowCount !== 1) return null;
        const ready = await client.query(
          `${claimableJobsSql}
           and job.id = $3
           for update of job`,
          [processorVersion, now, candidate.id],
        );
        if (ready.rowCount !== 1) {
          await releaseProjectLease(client, {
            projectId: candidate.project_id,
            leaseFence: lease.rows[0].fence,
            leaseToken: lease.rows[0].lease_token,
          });
          return null;
        }
        const claimed = await client.query(
          `update synapse_private.memory_processing_jobs
           set status = 'processing', attempt_count = attempt_count + 1,
               leased_by = $2, lease_token = $3, lease_fence = $4,
               lease_expires_at = $5, last_error = null
           where id = $1
           returning *`,
          [
            candidate.id,
            workerId,
            lease.rows[0].lease_token,
            lease.rows[0].fence,
            expiresAt,
          ],
        );
        const source = await client.query(
          `select revision.node_id, session.client_session_id,
                  revision.revision, revision.capture_id, revision.title,
                  revision.summary, revision.markdown,
                  revision.created_at as captured_at
           from public.memory_revisions as revision
           join public.memory_nodes as node on
             node.id = revision.node_id
             and node.owner_id = revision.owner_id
             and node.project_id = revision.project_id
             and node.kind = 'session'
           join public.agent_sessions as session on
             session.id = revision.author_session_id
             and session.owner_id = revision.owner_id
             and session.project_id = revision.project_id
             and session.client_session_id = node.source_session_id
           join public.projects as project on
             project.id = revision.project_id
             and project.owner_id = revision.owner_id
           where revision.id = $1`,
          [claimed.rows[0].revision_id],
        );
        if (source.rowCount !== 1) {
          throw new Error("queued revision relationships are inconsistent");
        }
        return jobFromRow({ ...claimed.rows[0], ...source.rows[0] });
      });
      if (job) return job;
    }
    return null;
  }

  async function renewLease(
    job,
    { leaseDurationMs = 30_000, now = new Date() } = {},
  ) {
    requirePositiveInteger(leaseDurationMs, "leaseDurationMs");
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    return transaction(async (client) => {
      const lease = await client.query(
        `update synapse_private.memory_processing_project_leases
         set lease_expires_at = $4
         where project_id = $1 and fence = $2 and lease_token = $3
           and lease_expires_at > $5`,
        [job.projectId, job.leaseFence, job.leaseToken, expiresAt, now],
      );
      const queued = await client.query(
        `update synapse_private.memory_processing_jobs
         set lease_expires_at = $4
         where id = $1 and lease_fence = $2 and lease_token = $3
           and status = 'processing' and lease_expires_at > $5`,
        [job.id, job.leaseFence, job.leaseToken, expiresAt, now],
      );
      if (lease.rowCount !== 1 || queued.rowCount !== 1) {
        throw new MemoryProcessingLeaseLostError();
      }
      job.leaseExpiresAt = expiresAt;
      return expiresAt;
    });
  }

  async function complete(job, commit, { now = new Date() } = {}) {
    if (typeof commit !== "function")
      throw new TypeError("commit must be a function");
    return transaction(async (client) => {
      const lease = await client.query(
        `select 1
         from synapse_private.memory_processing_project_leases
         where project_id = $1 and fence = $2 and lease_token = $3
           and lease_expires_at > $4
         for update`,
        [job.projectId, job.leaseFence, job.leaseToken, now],
      );
      const locked = await client.query(
        `select 1
         from synapse_private.memory_processing_jobs
         where id = $1 and project_id = $5 and status = 'processing'
           and lease_fence = $2 and lease_token = $3
           and lease_expires_at > $4
         for update`,
        [job.id, job.leaseFence, job.leaseToken, now, job.projectId],
      );
      if (lease.rowCount !== 1 || locked.rowCount !== 1) {
        const existing = await client.query(
          `select status::text
           from synapse_private.memory_processing_jobs
           where id = $1`,
          [job.id],
        );
        if (existing.rows[0]?.status === "succeeded") return false;
        throw new MemoryProcessingLeaseLostError();
      }
      await commit(client);
      const completed = await client.query(
        `update synapse_private.memory_processing_jobs
         set status = 'succeeded', completed_at = $4,
             leased_by = null, lease_token = null, lease_fence = null,
             lease_expires_at = null, last_error = null
         where id = $1 and lease_fence = $2 and lease_token = $3
           and status = 'processing'`,
        [job.id, job.leaseFence, job.leaseToken, now],
      );
      if (completed.rowCount !== 1) throw new MemoryProcessingLeaseLostError();
      await releaseProjectLease(client, job);
      return true;
    });
  }

  async function fail(job, error, { now = new Date() } = {}) {
    return transaction(async (client) => {
      const lease = await client.query(
        `select 1
         from synapse_private.memory_processing_project_leases
         where project_id = $1 and fence = $2 and lease_token = $3
           and lease_expires_at > $4
         for update`,
        [job.projectId, job.leaseFence, job.leaseToken, now],
      );
      if (lease.rowCount !== 1) throw new MemoryProcessingLeaseLostError();
      const locked = await client.query(
        `select attempt_count, max_attempts
         from synapse_private.memory_processing_jobs
         where id = $1 and lease_fence = $2 and lease_token = $3
           and status = 'processing' and lease_expires_at > $4
         for update`,
        [job.id, job.leaseFence, job.leaseToken, now],
      );
      if (locked.rowCount !== 1) throw new MemoryProcessingLeaseLostError();
      const attempts = Number(locked.rows[0].attempt_count);
      const failed = attempts >= Number(locked.rows[0].max_attempts);
      const availableAt = new Date(now.getTime() + retryDelay(attempts));
      await client.query(
        `update synapse_private.memory_processing_jobs
         set status = $4, available_at = $5, last_error = $6,
             leased_by = null, lease_token = null, lease_fence = null,
             lease_expires_at = null
         where id = $1 and lease_fence = $2 and lease_token = $3`,
        [
          job.id,
          job.leaseFence,
          job.leaseToken,
          failed ? "failed" : "pending",
          availableAt,
          boundedError(error),
        ],
      );
      await releaseProjectLease(client, job);
      return failed ? "failed" : "pending";
    });
  }

  return {
    claimNext,
    renewLease,
    complete,
    fail,
    recoverExpired,
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}
