import { createApplication } from "./app.mjs";
import { createSessionVerifier, createTokenVerifier } from "./auth.mjs";
import { loadConfig } from "./config.mjs";
import { createDatabase } from "./database.mjs";
import { createLogger } from "./logger.mjs";

const logger = createLogger();
let database;
let httpServer;
let mcpServer;

async function start() {
  const config = loadConfig();
  database = createDatabase(config);
  const verifier = createTokenVerifier(config, database);
  const sessionVerifier = createSessionVerifier(config);
  const runtime = await createApplication({
    config,
    database,
    verifier,
    sessionVerifier,
    logger,
  });
  mcpServer = runtime.server;
  httpServer = runtime.app.listen(config.port, "0.0.0.0", () => {
    logger.info("server_started", {
      port: config.port,
      resource: config.resourceUrl.href,
      development_tokens: config.allowDevTokens,
      public_signup: config.publicSignup,
    });
  });
}

async function shutdown(signal) {
  logger.info("server_stopping", { signal });
  if (httpServer) {
    await new Promise((resolvePromise) => httpServer.close(resolvePromise));
  }
  await mcpServer?.close();
  await database?.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown(signal)
      .catch((error) => {
        logger.error("shutdown_failed", { error_type: error.name });
        process.exitCode = 1;
      })
      .finally(() => process.exit());
  });
}

start().catch(async (error) => {
  logger.error("startup_failed", {
    error_type: error.name,
    message: error.message,
  });
  await database?.close();
  process.exitCode = 1;
});
