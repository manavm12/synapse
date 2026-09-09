import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { receiverRegistryPath } from "./receiver-registry.mjs";

function openState(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout = 250;
    CREATE TABLE IF NOT EXISTS synapse_onboarding (id INTEGER PRIMARY KEY CHECK(id = 1), preference TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receiver_destinations (
      server_url TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
      connection_id TEXT NOT NULL UNIQUE, last_check INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(server_url, user_id));
    CREATE TABLE IF NOT EXISTS receiver_leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
  return db;
}

export function offerSetupOnce({ path = receiverRegistryPath() } = {}) {
  const db = openState(path);
  try {
    return (
      db
        .prepare(
          "INSERT OR IGNORE INTO synapse_onboarding VALUES (1, 'offered')",
        )
        .run().changes === 1
    );
  } finally {
    db.close();
  }
}

export function deferSetup({ path = receiverRegistryPath() } = {}) {
  const db = openState(path);
  try {
    db.prepare(
      "INSERT INTO synapse_onboarding VALUES (1, 'deferred') ON CONFLICT(id) DO UPDATE SET preference='deferred'",
    ).run();
  } finally {
    db.close();
  }
}

export function activateDestination(
  connection,
  { path = receiverRegistryPath() } = {},
) {
  if (connection.status !== "connected" || !connection.identity?.enabled)
    throw new Error("Receiver is not connected");
  const db = openState(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    const current = db
      .prepare(
        "SELECT status FROM receiver_connections WHERE connection_id = ?",
      )
      .get(connection.connectionId);
    if (current?.status !== "connected")
      throw new Error("Receiver was disconnected during setup");
    const old = db
      .prepare(
        "SELECT connection_id FROM receiver_destinations WHERE server_url=? AND user_id=?",
      )
      .get(connection.serverUrl, connection.identity.userId);
    if (old && old.connection_id !== connection.connectionId)
      throw new Error(
        "Disable the existing receiving project before choosing another",
      );
    db.prepare(`INSERT INTO receiver_destinations(server_url,user_id,project_id,connection_id) VALUES (?,?,?,?)
      ON CONFLICT(server_url,user_id) DO UPDATE SET project_id=excluded.project_id,connection_id=excluded.connection_id`).run(
      connection.serverUrl,
      connection.identity.userId,
      connection.identity.projectId,
      connection.connectionId,
    );
    db.prepare(
      "INSERT INTO synapse_onboarding VALUES (1, 'enabled') ON CONFLICT(id) DO UPDATE SET preference='enabled'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function setupConnections({ path = receiverRegistryPath() } = {}) {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='receiver_connections'",
        )
        .get()
    )
      return [];
    return db
      .prepare(
        "SELECT connection_id, project_root AS project, project_alias, status FROM receiver_connections ORDER BY project_root",
      )
      .all();
  } finally {
    db.close();
  }
}

export function deactivateDestination(
  connectionId,
  { path = receiverRegistryPath() } = {},
) {
  const db = openState(path);
  try {
    db.prepare("DELETE FROM receiver_destinations WHERE connection_id=?").run(
      connectionId,
    );
  } finally {
    db.close();
  }
}

export function activeDestinations({ path = receiverRegistryPath() } = {}) {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    if (
      !["receiver_destinations", "receiver_connections"].every((name) =>
        tables.some((t) => t.name === name),
      )
    )
      return [];
    return db
      .prepare(`SELECT r.project_root AS projectRoot,r.connection_id AS connectionId
      FROM receiver_destinations d JOIN receiver_connections r ON r.connection_id=d.connection_id
      WHERE r.status='connected' ORDER BY d.last_check,d.connection_id LIMIT 10`)
      .all();
  } finally {
    db.close();
  }
}

export async function withReceiverLease(
  key,
  operation,
  { path = receiverRegistryPath(), ttlMs = 40_000, now = Date.now } = {},
) {
  const db = openState(path);
  const owner = randomUUID();
  try {
    const acquired = db
      .prepare(`INSERT INTO receiver_leases VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE receiver_leases.expires_at <= ?`)
      .run(key, owner, now() + ttlMs, now());
    if (!acquired.changes) return { busy: true };
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='receiver_connections'",
        )
        .get()
    )
      db.prepare(
        "UPDATE receiver_destinations SET last_check=? WHERE connection_id IN (SELECT connection_id FROM receiver_connections WHERE project_root=?)",
      ).run(now(), key.startsWith("receiver:") ? key.slice(9) : "");
    try {
      return await operation();
    } finally {
      db.prepare("DELETE FROM receiver_leases WHERE key=? AND owner=?").run(
        key,
        owner,
      );
    }
  } finally {
    db.close();
  }
}
