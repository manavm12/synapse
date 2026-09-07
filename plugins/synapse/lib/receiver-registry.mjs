import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function receiverRegistryPath(env = process.env) {
  const synapseHome = resolve(env.SYNAPSE_HOME ?? join(homedir(), ".synapse"));
  return resolve(env.SYNAPSE_HOST_DB ?? join(synapseHome, "host.sqlite"));
}

function openRegistry(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS receiver_connections (
      connection_id TEXT PRIMARY KEY,
      project_root TEXT NOT NULL UNIQUE,
      project_alias TEXT NOT NULL,
      server_url TEXT NOT NULL,
      credential_account TEXT NOT NULL UNIQUE,
      credential_hash TEXT NOT NULL,
      pairing_id TEXT,
      verification_url TEXT,
      pairing_expires_at TEXT,
      status TEXT NOT NULL,
      installation_id TEXT,
      user_id TEXT,
      username TEXT,
      cloud_project_id TEXT,
      cloud_project_alias TEXT,
      credential_expires_at TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  return database;
}

function fromRow(row) {
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    projectRoot: row.project_root,
    projectAlias: row.project_alias,
    serverUrl: row.server_url,
    credentialAccount: row.credential_account,
    credentialHash: row.credential_hash,
    pairingId: row.pairing_id,
    verificationUrl: row.verification_url,
    pairingExpiresAt: row.pairing_expires_at,
    status: row.status,
    identity: row.installation_id
      ? {
          installationId: row.installation_id,
          userId: row.user_id,
          username: row.username,
          projectId: row.cloud_project_id,
          projectAlias: row.cloud_project_alias,
          expiresAt: row.credential_expires_at,
          enabled: row.status === "connected",
        }
      : null,
  };
}

export function getReceiverConnection(
  projectRoot,
  { path = receiverRegistryPath() } = {},
) {
  const database = openRegistry(path);
  try {
    return fromRow(
      database
        .prepare("SELECT * FROM receiver_connections WHERE project_root = ?")
        .get(projectRoot),
    );
  } finally {
    database.close();
  }
}

export function getLocalProject(
  projectRoot,
  { path = receiverRegistryPath() } = {},
) {
  const database = openRegistry(path);
  try {
    const row = database
      .prepare("SELECT alias, root FROM projects WHERE root = ?")
      .get(projectRoot);
    return row ? { alias: row.alias, root: row.root } : null;
  } finally {
    database.close();
  }
}

export function beginReceiverConnection(
  {
    connectionId,
    projectRoot,
    projectAlias,
    serverUrl,
    credentialAccount,
    credentialHash,
  },
  { path = receiverRegistryPath(), now = Date.now } = {},
) {
  const database = openRegistry(path);
  try {
    const existing = database
      .prepare("SELECT * FROM receiver_connections WHERE project_root = ?")
      .get(projectRoot);
    if (existing?.status === "connected") {
      throw new Error(`Receiver is already connected for ${projectRoot}`);
    }
    if (existing) return fromRow(existing);
    database
      .prepare(`INSERT INTO receiver_connections (
        connection_id, project_root, project_alias, server_url, credential_account,
        credential_hash, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?)`)
      .run(
        connectionId,
        projectRoot,
        projectAlias,
        serverUrl,
        credentialAccount,
        credentialHash,
        now(),
      );
    return fromRow(
      database
        .prepare("SELECT * FROM receiver_connections WHERE connection_id = ?")
        .get(connectionId),
    );
  } finally {
    database.close();
  }
}

export function recordReceiverPairing(
  { connectionId, pairingId, verificationUrl, expiresAt },
  { path = receiverRegistryPath(), now = Date.now } = {},
) {
  const database = openRegistry(path);
  try {
    const result = database
      .prepare(`UPDATE receiver_connections SET pairing_id = ?, verification_url = ?,
        pairing_expires_at = ?, status = 'pending', updated_at = ? WHERE connection_id = ?`)
      .run(pairingId, verificationUrl, expiresAt, now(), connectionId);
    if (result.changes !== 1) throw new Error("Unknown receiver connection");
  } finally {
    database.close();
  }
}

export function completeReceiverConnection(
  { connectionId, identity },
  { path = receiverRegistryPath(), now = Date.now } = {},
) {
  const database = openRegistry(path);
  try {
    const row = database
      .prepare("SELECT * FROM receiver_connections WHERE connection_id = ?")
      .get(connectionId);
    if (!row) throw new Error("Unknown receiver connection");
    if (row.project_alias !== identity.projectAlias) {
      throw new Error(
        `Approved cloud project ${identity.projectAlias} does not match local alias ${row.project_alias}`,
      );
    }
    database
      .prepare(`UPDATE receiver_connections SET status = 'connected',
        installation_id = ?, user_id = ?, username = ?, cloud_project_id = ?,
        cloud_project_alias = ?, credential_expires_at = ?, updated_at = ?
        WHERE connection_id = ?`)
      .run(
        identity.installationId,
        identity.userId,
        identity.username,
        identity.projectId,
        identity.projectAlias,
        identity.expiresAt,
        now(),
        connectionId,
      );
    return fromRow(
      database
        .prepare("SELECT * FROM receiver_connections WHERE connection_id = ?")
        .get(connectionId),
    );
  } finally {
    database.close();
  }
}

export function markReceiverDisconnected(
  connectionId,
  { path = receiverRegistryPath(), now = Date.now } = {},
) {
  const database = openRegistry(path);
  try {
    const result = database
      .prepare(
        "UPDATE receiver_connections SET status = 'disconnected', updated_at = ? WHERE connection_id = ?",
      )
      .run(now(), connectionId);
    if (result.changes !== 1) throw new Error("Unknown receiver connection");
  } finally {
    database.close();
  }
}

export function markReceiverDisconnecting(
  connectionId,
  { path = receiverRegistryPath(), now = Date.now } = {},
) {
  const database = openRegistry(path);
  try {
    const result = database
      .prepare(`UPDATE receiver_connections SET status = 'disconnecting',
        updated_at = ? WHERE connection_id = ? AND status IN ('connected', 'disconnecting')`)
      .run(now(), connectionId);
    if (result.changes !== 1) throw new Error("Receiver is not connected");
  } finally {
    database.close();
  }
}

export function markReceiverRevoked(
  connectionId,
  { path = receiverRegistryPath(), now = Date.now } = {},
) {
  const database = openRegistry(path);
  try {
    const result = database
      .prepare(`UPDATE receiver_connections SET status = 'revoked',
        updated_at = ? WHERE connection_id = ? AND status IN ('disconnecting', 'revoked')`)
      .run(now(), connectionId);
    if (result.changes !== 1)
      throw new Error("Receiver revocation is not pending");
  } finally {
    database.close();
  }
}

export function removeReceiverConnection(
  connectionId,
  { path = receiverRegistryPath() } = {},
) {
  const database = openRegistry(path);
  try {
    database
      .prepare("DELETE FROM receiver_connections WHERE connection_id = ?")
      .run(connectionId);
  } finally {
    database.close();
  }
}
