import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CHECKPOINT_INTERVAL = 3;
export const REQUIRED_MEMORY_SECTIONS = Object.freeze([
  "Summary",
  "What changed",
  "Decisions",
  "Still unresolved",
  "Important references",
]);

const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function createMemoryPaths(env = process.env) {
  const synapseHome = resolve(env.SYNAPSE_HOME ?? join(homedir(), ".synapse"));
  return {
    synapseHome,
    hostDatabase: resolve(env.SYNAPSE_HOST_DB ?? join(synapseHome, "host.sqlite")),
    memoryDatabase: resolve(
      env.SYNAPSE_MEMORY_DB ?? join(synapseHome, "memory.sqlite"),
    ),
    memoryRoot: resolve(
      env.SYNAPSE_MEMORY_ROOT ?? join(synapseHome, "memory"),
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
  if (!existsSync(hostDatabase)) {
    return [];
  }

  let database;
  try {
    database = new DatabaseSync(hostDatabase, { readOnly: true });
    const table = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
      .get();
    if (!table) {
      return [];
    }
    return database.prepare("SELECT alias, root FROM projects").all();
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
    if (canonicalPath(project.root) === projectRoot) {
      return {
        alias: project.alias,
        root: projectRoot,
      };
    }
  }
  return null;
}

function projectIsStillRegistered(project, paths) {
  return readRegisteredProjects(paths.hostDatabase).some(
    (candidate) =>
      candidate.alias === project.alias &&
      canonicalPath(candidate.root) === canonicalPath(project.root),
  );
}

function openMemoryDatabase(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS memory_sessions (
      session_id TEXT PRIMARY KEY,
      project_alias TEXT NOT NULL,
      project_root TEXT NOT NULL,
      due_reason TEXT,
      due_turn_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      summary TEXT,
      document_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_saved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_turns (
      session_id TEXT NOT NULL REFERENCES memory_sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      saved_revision INTEGER,
      PRIMARY KEY (session_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS memory_turns_unsaved
      ON memory_turns(session_id, saved_revision);
  `);
  for (const suffix of ["", "-wal", "-shm"]) {
    const sqlitePath = `${path}${suffix}`;
    if (existsSync(sqlitePath)) {
      chmodSync(sqlitePath, 0o600);
    }
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

function ensureSession(database, { sessionId, project, now }) {
  const existing = database
    .prepare("SELECT * FROM memory_sessions WHERE session_id = ?")
    .get(sessionId);
  if (existing && canonicalPath(existing.project_root) !== project.root) {
    throw new Error(`Session ${sessionId} is already bound to another project`);
  }
  if (!existing) {
    database.prepare(`
      INSERT INTO memory_sessions (
        session_id, project_alias, project_root, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, project.alias, project.root, now, now);
  }
  return existing;
}

function checkpointReason(sessionId, reason) {
  return [
    `Synapse memory capture is due for session ${sessionId} (${reason}).`,
    "Before finishing, call the Synapse save_session_memory MCP tool exactly once.",
    "Write a concise durable session summary, not a transcript.",
    `The markdown must contain these headings: ${REQUIRED_MEMORY_SECTIONS.join(", ")}.`,
    "After the tool succeeds, finish the original task normally.",
  ].join(" ");
}

export function checkpointMemory(
  { sessionId, turnId, cwd, stopHookActive = false },
  { env = process.env, now = () => Date.now() } = {},
) {
  const safeSessionId = requireSessionId(sessionId);
  const safeTurnId = requireText(turnId, "turn_id");
  const paths = createMemoryPaths(env);
  const project = findRegisteredProject(cwd, paths);
  if (!project) {
    return { registered: false, due: false };
  }

  const timestamp = new Date(now()).toISOString();
  const database = openMemoryDatabase(paths.memoryDatabase);
  try {
    return inTransaction(database, () => {
      ensureSession(database, {
        sessionId: safeSessionId,
        project,
        now: timestamp,
      });
      const inserted = database.prepare(`
        INSERT OR IGNORE INTO memory_turns (session_id, turn_id, observed_at)
        VALUES (?, ?, ?)
      `).run(safeSessionId, safeTurnId, timestamp);
      const session = database
        .prepare("SELECT * FROM memory_sessions WHERE session_id = ?")
        .get(safeSessionId);
      const unsavedTurns = Number(
        database.prepare(`
          SELECT COUNT(*) AS count FROM memory_turns
          WHERE session_id = ? AND saved_revision IS NULL
        `).get(safeSessionId).count,
      );

      let dueReason = session.due_reason;
      if (!dueReason && unsavedTurns >= CHECKPOINT_INTERVAL) {
        dueReason = `${CHECKPOINT_INTERVAL} completed turns`;
        database.prepare(`
          UPDATE memory_sessions
          SET due_reason = ?, due_turn_id = ?, updated_at = ?
          WHERE session_id = ?
        `).run(dueReason, safeTurnId, timestamp, safeSessionId);
      }

      const result = {
        registered: true,
        due: Boolean(dueReason),
        duplicate: inserted.changes === 0,
        unsavedTurns,
        remainingTurns: Math.max(0, CHECKPOINT_INTERVAL - unsavedTurns),
        reason: dueReason,
      };
      if (dueReason && !stopHookActive) {
        result.decision = "block";
        result.reason = checkpointReason(safeSessionId, dueReason);
      }
      return result;
    });
  } finally {
    database.close();
  }
}

export function markCompactionDue(
  { sessionId, cwd },
  { env = process.env, now = () => Date.now() } = {},
) {
  const safeSessionId = requireSessionId(sessionId);
  const paths = createMemoryPaths(env);
  const project = findRegisteredProject(cwd, paths);
  if (!project) {
    return { registered: false, due: false };
  }

  const timestamp = new Date(now()).toISOString();
  const database = openMemoryDatabase(paths.memoryDatabase);
  try {
    return inTransaction(database, () => {
      ensureSession(database, {
        sessionId: safeSessionId,
        project,
        now: timestamp,
      });
      database.prepare(`
        UPDATE memory_sessions
        SET due_reason = 'compaction boundary', due_turn_id = NULL, updated_at = ?
        WHERE session_id = ?
      `).run(timestamp, safeSessionId);
      return {
        registered: true,
        due: true,
        reason: "compaction boundary",
        prompt: checkpointReason(safeSessionId, "compaction boundary"),
      };
    });
  } finally {
    database.close();
  }
}

function validateMarkdown(markdown) {
  const body = requireText(markdown, "markdown");
  const missing = REQUIRED_MEMORY_SECTIONS.filter((section) => {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").test(body);
  });
  if (missing.length > 0) {
    throw new Error(`markdown is missing required headings: ${missing.join(", ")}`);
  }
  return body;
}

function safeProjectDirectory(alias) {
  const safe = String(alias).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  if (!safe || safe === "." || safe === "..") {
    return `project-${createHash("sha256").update(String(alias)).digest("hex").slice(0, 12)}`;
  }
  return safe;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function renderMemoryDocument({
  sessionId,
  project,
  title,
  summary,
  markdown,
  revision,
  createdAt,
  updatedAt,
}) {
  return [
    "---",
    `session_id: ${yamlString(sessionId)}`,
    `project: ${yamlString(project.alias)}`,
    `project_root: ${yamlString(project.root)}`,
    `title: ${yamlString(title)}`,
    `summary: ${yamlString(summary)}`,
    `revision: ${revision}`,
    `created_at: ${yamlString(createdAt)}`,
    `updated_at: ${yamlString(updatedAt)}`,
    "---",
    "",
    markdown,
    "",
  ].join("\n");
}

export async function saveSessionMemory(
  { sessionId, title, summary, markdown },
  { env = process.env, now = () => Date.now() } = {},
) {
  const safeSessionId = requireSessionId(sessionId);
  const safeTitle = requireText(title, "title");
  const safeSummary = requireText(summary, "summary");
  const safeMarkdown = validateMarkdown(markdown);
  const paths = createMemoryPaths(env);
  if (!existsSync(paths.memoryDatabase)) {
    throw new Error(`Unknown memory session: ${safeSessionId}`);
  }

  const database = openMemoryDatabase(paths.memoryDatabase);
  let temporaryPath;
  try {
    return inTransaction(database, () => {
      const session = database
        .prepare("SELECT * FROM memory_sessions WHERE session_id = ?")
        .get(safeSessionId);
      if (!session) {
        throw new Error(`Unknown memory session: ${safeSessionId}`);
      }
      const project = {
        alias: session.project_alias,
        root: canonicalPath(session.project_root),
      };
      if (!projectIsStillRegistered(project, paths)) {
        throw new Error(`Project ${project.alias} is no longer registered with Synapse`);
      }

      const timestamp = new Date(now()).toISOString();
      const revision = Number(session.revision) + 1;
      const projectDirectory = join(
        paths.memoryRoot,
        safeProjectDirectory(project.alias),
      );
      mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
      chmodSync(paths.memoryRoot, 0o700);
      chmodSync(projectDirectory, 0o700);
      const documentPath = join(projectDirectory, `${safeSessionId}.md`);
      temporaryPath = join(
        projectDirectory,
        `.${safeSessionId}.${process.pid}.${randomUUID()}.tmp`,
      );
      const document = renderMemoryDocument({
        sessionId: safeSessionId,
        project,
        title: safeTitle,
        summary: safeSummary,
        markdown: safeMarkdown,
        revision,
        createdAt: session.created_at,
        updatedAt: timestamp,
      });
      writeFileSync(temporaryPath, document, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, documentPath);
      temporaryPath = null;

      database.prepare(`
        UPDATE memory_sessions
        SET due_reason = NULL,
            due_turn_id = NULL,
            revision = ?,
            title = ?,
            summary = ?,
            document_path = ?,
            updated_at = ?,
            last_saved_at = ?
        WHERE session_id = ?
      `).run(
        revision,
        safeTitle,
        safeSummary,
        documentPath,
        timestamp,
        timestamp,
        safeSessionId,
      );
      database.prepare(`
        UPDATE memory_turns SET saved_revision = ?
        WHERE session_id = ? AND saved_revision IS NULL
      `).run(revision, safeSessionId);

      return {
        saved: true,
        sessionId: safeSessionId,
        projectAlias: project.alias,
        path: documentPath,
        revision,
        savedAt: timestamp,
      };
    });
  } finally {
    if (temporaryPath) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Ignore cleanup failures; the original save error is more useful.
      }
    }
    database.close();
  }
}
