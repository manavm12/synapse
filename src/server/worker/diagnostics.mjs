import { MemoryInferenceError } from "../memory-organizer/api.mjs";

export class WorkerConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerConfigurationError";
  }
}

export class WorkerDatabaseError extends Error {
  constructor(category) {
    super(`Memory worker ${category}`);
    this.name = "WorkerDatabaseError";
    this.category = category;
  }
}

// Return only fixed categories; neither arbitrary messages nor provider bodies
// belong in operational logs, including PostgreSQL errors carrying SQL values.
export function workerFailureCategory(error) {
  if (error instanceof WorkerConfigurationError) return "configuration";
  if (error instanceof WorkerDatabaseError)
    return ["database_role", "database_schema", "project_scope"].includes(
      error.category,
    )
      ? error.category
      : "database";
  if (error?.name === "MemoryProcessingLeaseLostError") return "lease_lost";
  if (error?.name === "MemoryLedgerGenerationError") return "ledger_generation";
  if (error instanceof MemoryInferenceError) {
    const code = error.code;
    if (["HTTP 401", "HTTP 403", "HTTP 404"].includes(code))
      return "model_access";
    if (code === "HTTP 429") return "model_rate_limit";
    if (code === "timeout") return "model_timeout";
    if (code === "cancelled") return "cancelled";
    if (
      ["context limit reached; no truncation", "prompt size exceeded"].includes(
        code,
      )
    )
      return "context_limit";
    if (code === "semantic review rejected proposal") return "review_rejected";
    if (code === "incomplete response") return "model_incomplete";
    if (code === "output token limit reached") return "model_output_limit";
    if (code === "content filtered") return "model_content_filter";
    if (code === "provider response failed") return "model_response_failed";
    if (error.transport) return "model_transport";
    return "model_validation";
  }
  if (["42P01", "42703", "42704", "42883"].includes(error?.code))
    return "database_schema";
  if (["42501", "28P01", "28000"].includes(error?.code))
    return "database_permissions";
  if (["57014", "55P03"].includes(error?.code)) return "database_timeout";
  if (
    ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"].includes(
      error?.code,
    )
  )
    return "database_connection";
  return "unknown";
}

export function workerFailureDetails(error) {
  return error instanceof MemoryInferenceError ? error.details : {};
}

export async function requireWorkerRole(client) {
  const { rows } = await client.query(`
    select role.rolsuper, role.rolbypassrls,
           pg_has_role(current_user, 'synapse_memory_worker', 'member') as worker,
           pg_has_role(current_user, 'synapse_runtime', 'member') as runtime
    from pg_roles as role where role.rolname = current_user
  `);
  const role = rows[0];
  if (!role?.worker || role.runtime || role.rolsuper || role.rolbypassrls)
    throw new WorkerDatabaseError("database_role");
}
