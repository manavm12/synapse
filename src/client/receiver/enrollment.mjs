import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { ReceiverClient } from "../../../plugins/synapse/lib/receiver-client.mjs";
import {
  credentialHash,
  validateReceiverIdentity,
} from "../../../plugins/synapse/lib/receiver-contract.mjs";
import {
  beginReceiverConnection,
  completeReceiverConnection,
  getLocalProject,
  getReceiverConnection,
  markReceiverDisconnected,
  markReceiverDisconnecting,
  markReceiverRevoked,
  receiverRegistryPath,
  recordReceiverPairing,
  removeReceiverConnection,
} from "../../../plugins/synapse/lib/receiver-registry.mjs";
import { MacOsKeychainStore } from "../../../plugins/synapse/lib/receiver-secrets.mjs";
import { resolveProjectRoot } from "../project-registry.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_ENROLLMENT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function allowInsecure(env) {
  return env.SYNAPSE_ALLOW_INSECURE_RECEIVER_HTTP === "1";
}

async function openVerificationUrl(url, { runCommand = execFileAsync } = {}) {
  await runCommand("/usr/bin/open", [url], {
    stdio: "ignore",
  });
}

function receiverCredential(createBytes = randomBytes) {
  return `syn_recv_${createBytes(32).toString("base64url")}`;
}

function validateHttpsUrl(value, env, label) {
  const url = new URL(value);
  const localHttp =
    allowInsecure(env) &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error(`${label} must use HTTPS`);
  }
}

async function revokeReceiverConnection(
  connection,
  { env, registryPath, secretStore, createClient },
) {
  if (connection.status !== "revoked") {
    const credential = await secretStore.get(connection.credentialAccount);
    markReceiverDisconnecting(connection.connectionId, { path: registryPath });
    const client = createClient({
      serverUrl: connection.serverUrl,
      credential,
      allowInsecureHttp: allowInsecure(env),
    });
    const result = await client.disconnect();
    if (result.disconnected !== true) {
      throw new Error("Receiver disconnect was not confirmed");
    }
    markReceiverRevoked(connection.connectionId, { path: registryPath });
  }
  await secretStore.delete(connection.credentialAccount);
  markReceiverDisconnected(connection.connectionId, { path: registryPath });
}

export async function startReceiverConnection(
  { project = ".", cwd = process.cwd(), serverUrl },
  {
    env = process.env,
    resolveRoot = resolveProjectRoot,
    registryPath = receiverRegistryPath(env),
    secretStore = new MacOsKeychainStore(),
    createClient = (options) => new ReceiverClient(options),
    createId = randomUUID,
    createBytes = randomBytes,
    now = Date.now,
    openUrl = openVerificationUrl,
    openBrowser = true,
  } = {},
) {
  if (typeof serverUrl !== "string" || !serverUrl) {
    throw new Error("Receiver server URL is required");
  }
  validateHttpsUrl(serverUrl, env, "Receiver server URL");
  const projectRoot = await resolveRoot(project, cwd);
  const localProject = getLocalProject(projectRoot, { path: registryPath });
  if (!localProject) {
    throw new Error(
      "Project must be connected with Synapse setup before enabling its receiver",
    );
  }
  let connection = getReceiverConnection(projectRoot, { path: registryPath });
  if (connection?.status === "disconnected") {
    removeReceiverConnection(connection.connectionId, { path: registryPath });
    connection = null;
  }
  if (connection && connection.serverUrl !== serverUrl) {
    throw new Error(`Receiver enrollment uses ${connection.serverUrl}`);
  }
  const credentialExpired =
    connection?.identity?.expiresAt &&
    Date.parse(connection.identity.expiresAt) <= now();
  let credential;
  if (credentialExpired) {
    await revokeReceiverConnection(connection, {
      env,
      registryPath,
      secretStore,
      createClient,
    });
    removeReceiverConnection(connection.connectionId, { path: registryPath });
    connection = null;
  } else if (["disconnecting", "revoked"].includes(connection?.status)) {
    throw new Error(
      "Receiver disconnect is incomplete; rerun receiver disconnect before connecting",
    );
  }
  if (connection) {
    credential = await secretStore.get(connection.credentialAccount);
  } else {
    const connectionId = createId();
    const credentialAccount = `receiver:${connectionId}`;
    credential = receiverCredential(createBytes);
    await secretStore.set(credentialAccount, credential);
    connection = beginReceiverConnection(
      {
        connectionId,
        projectRoot,
        projectAlias: localProject.alias,
        serverUrl,
        credentialAccount,
        credentialHash: credentialHash(credential),
      },
      { path: registryPath },
    );
  }
  if (connection.status === "connected") return connection;
  const pairingExpired =
    connection.pairingExpiresAt &&
    Date.parse(connection.pairingExpiresAt) <= now();
  if (!connection.pairingId || pairingExpired) {
    const client = createClient({
      serverUrl,
      credential,
      allowInsecureHttp: allowInsecure(env),
    });
    const pairing = await client.createPairing(connection.credentialHash);
    if (
      typeof pairing.pairing_id !== "string" ||
      !pairing.pairing_id ||
      typeof pairing.verification_url !== "string" ||
      !pairing.verification_url ||
      typeof pairing.expires_at !== "string" ||
      !Number.isFinite(Date.parse(pairing.expires_at))
    ) {
      throw new Error("Receiver server returned an invalid pairing");
    }
    validateHttpsUrl(
      pairing.verification_url,
      env,
      "Receiver verification URL",
    );
    recordReceiverPairing(
      {
        connectionId: connection.connectionId,
        pairingId: pairing.pairing_id,
        verificationUrl: pairing.verification_url,
        expiresAt: pairing.expires_at,
      },
      { path: registryPath },
    );
    connection = getReceiverConnection(projectRoot, { path: registryPath });
  }
  if (openBrowser) await openUrl(connection.verificationUrl);
  return connection;
}

export async function finishReceiverConnection(
  { project = ".", cwd = process.cwd() },
  {
    env = process.env,
    resolveRoot = resolveProjectRoot,
    registryPath = receiverRegistryPath(env),
    secretStore = new MacOsKeychainStore(),
    createClient = (options) => new ReceiverClient(options),
  } = {},
) {
  const projectRoot = await resolveRoot(project, cwd);
  const connection = getReceiverConnection(projectRoot, { path: registryPath });
  if (!connection?.pairingId)
    throw new Error("No pending receiver enrollment for this project");
  if (connection.status === "connected") return connection;
  const credential = await secretStore.get(connection.credentialAccount);
  const client = createClient({
    serverUrl: connection.serverUrl,
    credential,
    allowInsecureHttp: allowInsecure(env),
  });
  const result = await client.completePairing(connection.pairingId);
  if (result.status === "pending" && result.statusCode === 202) {
    return { ...connection, status: "pending" };
  }
  if (result.status !== "connected") {
    throw new Error("Receiver pairing returned an invalid completion status");
  }
  const identity = validateReceiverIdentity(result.identity);
  return completeReceiverConnection(
    { connectionId: connection.connectionId, identity },
    { path: registryPath },
  );
}

export async function enrollReceiver(
  input,
  {
    start = startReceiverConnection,
    finish = finishReceiverConnection,
    wait = (milliseconds) =>
      new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
    now = Date.now,
    timeoutMs = DEFAULT_ENROLLMENT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    ...dependencies
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Receiver enrollment timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Receiver polling interval must be a positive integer");
  }

  const initial = await start(input, dependencies);
  if (initial.status === "connected") {
    return { connection: initial, changed: false };
  }

  const deadline = now() + timeoutMs;
  while (true) {
    const connection = await finish(
      { project: input.project, cwd: input.cwd },
      dependencies,
    );
    if (connection.status === "connected") {
      return { connection, changed: true };
    }
    if (now() >= deadline) {
      throw new Error(
        `Receiver approval timed out. Approve it at ${initial.verificationUrl}, then rerun the same setup command.`,
      );
    }
    await wait(pollIntervalMs);
  }
}

export async function receiverStatus(
  { project = ".", cwd = process.cwd() },
  {
    env = process.env,
    resolveRoot = resolveProjectRoot,
    registryPath = receiverRegistryPath(env),
  } = {},
) {
  const projectRoot = await resolveRoot(project, cwd);
  return getReceiverConnection(projectRoot, { path: registryPath });
}

export async function disconnectReceiver(
  { project = ".", cwd = process.cwd() },
  {
    env = process.env,
    resolveRoot = resolveProjectRoot,
    registryPath = receiverRegistryPath(env),
    secretStore = new MacOsKeychainStore(),
    createClient = (options) => new ReceiverClient(options),
  } = {},
) {
  const projectRoot = await resolveRoot(project, cwd);
  const connection = getReceiverConnection(projectRoot, { path: registryPath });
  if (!connection) throw new Error("No receiver connection for this project");
  if (connection.status === "disconnected") {
    return { disconnected: true, projectRoot };
  }
  await revokeReceiverConnection(connection, {
    env,
    registryPath,
    secretStore,
    createClient,
  });
  return { disconnected: true, projectRoot };
}
