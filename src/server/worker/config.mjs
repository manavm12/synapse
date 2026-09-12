import { databaseConnectionOptions, databaseSsl } from "../../database-ssl.mjs";
import { WorkerConfigurationError } from "./diagnostics.mjs";

function integer(env, key, fallback, min, max) {
  const raw = env[key];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkerConfigurationError(
      `${key} must be an integer from ${min} to ${max}`,
    );
  }
  return value;
}

function required(env, key) {
  const value = env[key]?.trim();
  if (!value)
    throw new WorkerConfigurationError(
      `${key} is required for memory processing`,
    );
  return value;
}

export function loadWorkerDatabaseConfig(env = process.env) {
  let ssl;
  try {
    ssl = databaseSsl(env);
  } catch {
    throw new WorkerConfigurationError("Invalid database TLS configuration");
  }
  if (env.NODE_ENV === "production" && (ssl === false || !ssl?.ca))
    throw new WorkerConfigurationError(
      "Production workers require DATABASE_SSL=verify-full and DATABASE_CA_CERT",
    );
  const databaseUrl = required(env, "DATABASE_WORKER_URL");
  try {
    databaseConnectionOptions({ connectionString: databaseUrl, ssl });
  } catch {
    throw new WorkerConfigurationError(
      "Invalid worker database URL or TLS override",
    );
  }
  return { databaseUrl, databaseSsl: ssl };
}

export function loadWorkerConfig(env = process.env) {
  const enabled = env.MEMORY_PROCESSING_ENABLED ?? "false";
  if (!["true", "false"].includes(enabled)) {
    throw new WorkerConfigurationError(
      "MEMORY_PROCESSING_ENABLED must be true or false",
    );
  }
  // Disabled workers neither require credentials nor initialize a database/API.
  if (enabled === "false") return Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: true,
    ...loadWorkerDatabaseConfig(env),
    apiKey: required(env, "OPENAI_API_KEY"),
    model: required(env, "MEMORY_MODEL"),
    reviewModel:
      env.MEMORY_REVIEW_MODEL?.trim() || required(env, "MEMORY_MODEL"),
    reviewStrategy: "always",
    maxStageCalls: integer(env, "MEMORY_MAX_STAGE_CALLS", 2, 1, 3),
    requestTimeoutMs: integer(
      env,
      "MEMORY_REQUEST_TIMEOUT_MS",
      60_000,
      1_000,
      180_000,
    ),
    maxOutputTokens: integer(
      env,
      "MEMORY_MAX_OUTPUT_TOKENS",
      8_000,
      256,
      32_000,
    ),
    pollIntervalMs: integer(env, "MEMORY_POLL_INTERVAL_MS", 2_000, 100, 60_000),
    errorDelayMs: integer(env, "MEMORY_ERROR_DELAY_MS", 5_000, 100, 60_000),
    leaseDurationMs: integer(
      env,
      "MEMORY_LEASE_DURATION_MS",
      60_000,
      3_000,
      300_000,
    ),
  });
}
