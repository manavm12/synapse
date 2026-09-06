import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CHECKPOINT_INTERVAL = 15;
export const REQUIRED_MEMORY_SECTIONS = Object.freeze([
  "Summary",
  "What changed",
  "Decisions",
  "Still unresolved",
  "Important references",
]);

const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_PROJECT_ALIAS = /^[a-z][a-z0-9_-]{1,62}$/;

export function createMemoryPaths(env = process.env) {
  const synapseHome = resolve(env.SYNAPSE_HOME ?? join(homedir(), ".synapse"));
  return {
    synapseHome,
    hostDatabase: resolve(
      env.SYNAPSE_HOST_DB ?? join(synapseHome, "host.sqlite"),
    ),
    checkpointDatabase: resolve(
      env.SYNAPSE_CHECKPOINT_DB ?? join(synapseHome, "checkpoints.sqlite"),
    ),
  };
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireSessionId(value) {
  const sessionId = requireText(value, "session_id");
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error("session_id contains unsupported characters");
  }
  return sessionId;
}

function checkpointInterval(env) {
  const configured = env.SYNAPSE_CHECKPOINT_INTERVAL;
  if (configured === undefined || configured === "") return CHECKPOINT_INTERVAL;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(
      "SYNAPSE_CHECKPOINT_INTERVAL must be an integer from 1 to 1000",
    );
  }
  return value;
}

function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function gitPath(cwd, argument) {
  const value = execFileSync("git", ["-C", cwd, "rev-parse", argument], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export function resolveGitProjectRoot(cwd) {
  const workingDirectory = requireText(cwd, "cwd");
  return canonicalPath(dirname(gitPath(workingDirectory, "--git-common-dir")));
}

function readRegisteredProjects(hostDatabase) {
  if (!existsSync(hostDatabase)) return [];
  let database;
  try {
    database = new DatabaseSync(hostDatabase, { readOnly: true });
    const table = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
      )
      .get();
    return table
      ? database.prepare("SELECT alias, root FROM projects").all()
      : [];
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

export function findRegisteredProject(cwd, paths = createMemoryPaths()) {
  let projectRoot;
  try {
    projectRoot = resolveGitProjectRoot(cwd);
  } catch {
    return null;
  }
  for (const project of readRegisteredProjects(paths.hostDatabase)) {
    if (
      typeof project.alias === "string" &&
      SAFE_PROJECT_ALIAS.test(project.alias) &&
      canonicalPath(project.root) === projectRoot
    ) {
      return { alias: project.alias, root: projectRoot };
    }
  }
  return null;
}

function openCheckpointDatabase(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS checkpoint_sessions (
      session_id TEXT PRIMARY KEY,
      project_alias TEXT NOT NULL,
      project_root TEXT NOT NULL,
      due_capture_id TEXT,
      due_reason TEXT,
      due_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkpoint_turns (
      session_id TEXT NOT NULL REFERENCES checkpoint_sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      capture_id TEXT,
      PRIMARY KEY (session_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS checkpoint_turns_pending
      ON checkpoint_turns(session_id, capture_id);
  `);
  for (const suffix of ["", "-wal", "-shm"]) {
    const sqlitePath = `${path}${suffix}`;
    if (existsSync(sqlitePath)) chmodSync(sqlitePath, 0o600);
  }
  return database;
}

function inTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function ensureSession(database, { sessionId, project, timestamp }) {
  const existing = database
    .prepare("SELECT * FROM checkpoint_sessions WHERE session_id = ?")
    .get(sessionId);
  if (existing && canonicalPath(existing.project_root) !== project.root) {
    throw new Error(`Session ${sessionId} is already bound to another project`);
  }
  if (!existing) {
    database
      .prepare(`
      INSERT INTO checkpoint_sessions (
        session_id, project_alias, project_root, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
      .run(sessionId, project.alias, project.root, timestamp, timestamp);
  }
}

function capturePrompt({ sessionId, projectAlias, captureId, reason }) {
  return [
    `Synapse cloud memory capture is due for session ${sessionId} (${reason}).`,
    "Before finishing, call synapse-memory.save_session_memory exactly once with",
    `capture_id=${captureId}, session_id=${sessionId}, project_alias=${projectAlias}, and capture_reason=${reason}.`,
    "Write a concise durable session summary, not a transcript.",
    `The markdown must contain these headings: ${REQUIRED_MEMORY_SECTIONS.join(", ")}.`,
    "If authentication, networking, or saving fails, continue and finish the original task; do not retry or write a local memory copy.",
  ].join(" ");
}

export function checkpointMemory(
  { sessionId, turnId, cwd, stopHookActive = false },
  {
    env = process.env,
    now = () => Date.now(),
    createCaptureId = randomUUID,
  } = {},
) {
  const safeSessionId = requireSessionId(sessionId);
  const safeTurnId = requireText(turnId, "turn_id");
  const paths = createMemoryPaths(env);
  const project = findRegisteredProject(cwd, paths);
  if (!project) return { registered: false, due: false };

  const interval = checkpointInterval(env);
  const timestamp = new Date(now()).toISOString();
  const database = openCheckpointDatabase(paths.checkpointDatabase);
  try {
    return inTransaction(database, () => {
      ensureSession(database, {
        sessionId: safeSessionId,
        project,
        timestamp,
      });
      let session = database
        .prepare("SELECT * FROM checkpoint_sessions WHERE session_id = ?")
        .get(safeSessionId);

      // The continuation exists only to perform the remote save. It must not
      // become the first turn in the next interval. Clearing here deliberately
      // implements fail-open behavior regardless of the remote call's result.
      if (stopHookActive) {
        if (session.due_capture_id) {
          database
            .prepare(`
            UPDATE checkpoint_turns SET capture_id = ?
            WHERE session_id = ? AND capture_id IS NULL
          `)
            .run(session.due_capture_id, safeSessionId);
          database
            .prepare(`
            UPDATE checkpoint_sessions
            SET due_capture_id = NULL, due_reason = NULL, due_turn_id = NULL,
                updated_at = ?
            WHERE session_id = ?
          `)
            .run(timestamp, safeSessionId);
        }
        return {
          registered: true,
          due: false,
          continuation: true,
          completedCaptureId: session.due_capture_id ?? null,
        };
      }

      const inserted = database
        .prepare(`
        INSERT OR IGNORE INTO checkpoint_turns (session_id, turn_id, observed_at)
        VALUES (?, ?, ?)
      `)
        .run(safeSessionId, safeTurnId, timestamp);
      const pendingTurns = Number(
        database
          .prepare(`
          SELECT COUNT(*) AS count FROM checkpoint_turns
          WHERE session_id = ? AND capture_id IS NULL
        `)
          .get(safeSessionId).count,
      );

      if (!session.due_capture_id && pendingTurns >= interval) {
        const captureId = createCaptureId();
        database
          .prepare(`
          UPDATE checkpoint_sessions
          SET due_capture_id = ?, due_reason = 'turn_checkpoint',
              due_turn_id = ?, updated_at = ?
          WHERE session_id = ?
        `)
          .run(captureId, safeTurnId, timestamp, safeSessionId);
        session = database
          .prepare("SELECT * FROM checkpoint_sessions WHERE session_id = ?")
          .get(safeSessionId);
      }

      const due = Boolean(session.due_capture_id);
      const result = {
        registered: true,
        due,
        duplicate: inserted.changes === 0,
        pendingTurns,
        remainingTurns: Math.max(0, interval - pendingTurns),
        captureId: session.due_capture_id ?? null,
        reason: session.due_reason ?? null,
      };
      if (due) {
        result.decision = "block";
        result.reason = capturePrompt({
          sessionId: safeSessionId,
          projectAlias: project.alias,
          captureId: session.due_capture_id,
          reason: "turn_checkpoint",
        });
      }
      return result;
    });
  } finally {
    database.close();
  }
}

export function createCompactionCheckpoint(
  { sessionId, cwd },
  { env = process.env, createCaptureId = randomUUID } = {},
) {
  const safeSessionId = requireSessionId(sessionId);
  const project = findRegisteredProject(cwd, createMemoryPaths(env));
  if (!project) return { registered: false, due: false };
  const captureId = createCaptureId();
  return {
    registered: true,
    due: true,
    captureId,
    reason: "compaction",
    prompt: capturePrompt({
      sessionId: safeSessionId,
      projectAlias: project.alias,
      captureId,
      reason: "compaction",
    }),
  };
}
