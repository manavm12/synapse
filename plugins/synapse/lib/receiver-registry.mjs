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
    CREATE TABLE IF NOT EXISTS receiver_connection_history (
      connection_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, user_id TEXT
    );
  `);
  try {
    database.exec("BEGIN IMMEDIATE");
    const columns = database
      .prepare("PRAGMA table_info(receiver_connections)")
      .all();
    for (const name of ["expected_user_id", "expected_project_id"]) {
      if (!columns.some((column) => column.name === name)) {
        database.exec(
          `ALTER TABLE receiver_connections ADD COLUMN ${name} TEXT`,
        );
      }
    }
    if (!columns.some((column) => column.name === "credential_ready"))
      database.exec(
        "ALTER TABLE receiver_connections ADD COLUMN credential_ready INTEGER NOT NULL DEFAULT 1",
      );
    database.exec("COMMIT");
  } catch (error) {
    database.close();
    throw error;
  }
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
    credentialReady: Boolean(row.credential_ready),
    pairingId: row.pairing_id,
    verificationUrl: row.verification_url,
    pairingExpiresAt: row.pairing_expires_at,
    status: row.status,
    expectedUserId: row.expected_user_id ?? null,
    expectedProjectId: row.expected_project_id ?? null,
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

export function getReceiverConnectionById(
  connectionId,
  { path = receiverRegistryPath() } = {},
) {
  const database = openRegistry(path);
  try {
    return fromRow(
      database
        .prepare("SELECT * FROM receiver_connections WHERE connection_id=?")
        .get(connectionId),
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
    expectedUserId = null,
    expectedProjectId = null,
    credentialReady = true,
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
        credential_hash, status, updated_at, expected_user_id, expected_project_id, credential_ready
      ) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?)`)
      .run(
        connectionId,
        projectRoot,
        projectAlias,
        serverUrl,
        credentialAccount,
        credentialHash,
        now(),
        expectedUserId,
        expectedProjectId,
        Number(credentialReady),
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

export function markCredentialReady(
  connectionId,
  { path = receiverRegistryPath() } = {},
) {
  const db = openRegistry(path);
  try {
    const result = db
      .prepare(
        "UPDATE receiver_connections SET credential_ready=1 WHERE connection_id=? AND status='starting'",
      )
      .run(connectionId);
    if (result.changes !== 1)
      throw new Error("Setup was cancelled before credential publication");
  } finally {
    db.close();
  }
}

export function receiverTarget(
  connectionId,
  { path = receiverRegistryPath() } = {},
) {
  const db = openRegistry(path);
  try {
    return db
      .prepare(`SELECT project_root AS projectRoot,coalesce(expected_user_id,user_id) AS userId FROM receiver_connections WHERE connection_id=?
      UNION ALL SELECT project_root AS projectRoot,user_id AS userId FROM receiver_connection_history WHERE connection_id=? LIMIT 1`)
      .get(connectionId, connectionId);
  } finally {
    db.close();
  }
}

// Couple the final local authorization check to the durable inbox issue marker.
// Disable cannot change the receiver row between these two synchronous writes.
export function withReceiverAuthorization(
  { projectRoot, identity },
  operation,
  { path = receiverRegistryPath(), now = Date.now } = {},
) {
  const db = openRegistry(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db
      .prepare("SELECT * FROM receiver_connections WHERE project_root=?")
      .get(projectRoot);
    if (
      row?.status !== "connected" ||
      row.installation_id !== identity?.installationId ||
      row.user_id !== identity?.userId ||
      row.cloud_project_id !== identity?.projectId ||
      row.cloud_project_alias !== identity?.projectAlias ||
      Date.parse(row.credential_expires_at) <= now()
    ) {
      throw new Error("Cloud receiver authorization is no longer current");
    }
    const result = operation();
    if (result?.then)
      throw new Error("Receiver authorization fence must be synchronous");
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
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
        pairing_expires_at = ?, status = 'pending', updated_at = ? WHERE connection_id = ? AND status IN ('starting','pending')`)
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
    if (
      (row.expected_user_id && row.expected_user_id !== identity.userId) ||
      (row.expected_project_id &&
        row.expected_project_id !== identity.projectId)
    ) {
      throw new Error(
        "Approved account does not match Synapse sign-in; reconnect from setup",
      );
    }
    if (!["pending", "connected"].includes(row.status)) {
      throw new Error("Receiver completion was cancelled");
    }
    const updated = database
      .prepare(`UPDATE receiver_connections SET status = 'connected',
        installation_id = ?, user_id = ?, username = ?, cloud_project_id = ?,
        cloud_project_alias = ?, credential_expires_at = ?, updated_at = ?
        WHERE connection_id = ? AND status IN ('pending','connected')`)
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
    if (updated.changes !== 1)
      throw new Error("Receiver completion was cancelled");
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
        updated_at = ? WHERE connection_id = ?
          AND status IN ('starting', 'pending', 'connected', 'disconnecting')`)
      .run(now(), connectionId);
    if (result.changes !== 1) {
      throw new Error("Receiver cannot begin disconnect recovery");
    }
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
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(`INSERT OR IGNORE INTO receiver_connection_history(connection_id,project_root,user_id)
      SELECT connection_id,project_root,coalesce(expected_user_id,user_id) FROM receiver_connections WHERE connection_id=?`)
      .run(connectionId);
    database
      .prepare("DELETE FROM receiver_connections WHERE connection_id = ?")
      .run(connectionId);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

export function listReceiverConnections({
  path = receiverRegistryPath(),
  activeOnly = false,
} = {}) {
  const database = openRegistry(path);
  try {
    const selected =
      activeOnly &&
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='receiver_destinations'",
        )
        .get();
    return database
      .prepare(
        `SELECT * FROM receiver_connections WHERE status='connected' ${selected ? "AND connection_id IN (SELECT connection_id FROM receiver_destinations)" : ""}`,
      )
      .all()
      .map(fromRow);
  } finally {
    database.close();
  }
}
