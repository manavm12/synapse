import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return database;
}

function relayTaskFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    hostId: row.host_id,
    conversationId: row.conversation_id,
    project: row.project,
    prompt: row.prompt,
    status: row.status,
    threadId: row.thread_id,
    worktreePath: row.worktree_path,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RelayStore {
  constructor(path, { now = () => Date.now(), createId = randomUUID } = {}) {
    this.database = openDatabase(path);
    this.now = now;
    this.createId = createId;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        project TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        thread_id TEXT,
        worktree_path TEXT,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_host_status
        ON tasks(host_id, status, created_at);
    `);
  }

  createTask(input) {
    const id = input.id ?? this.createId();
    const now = this.now();
    this.database.prepare(`
      INSERT INTO tasks (
        id, host_id, conversation_id, project, prompt, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(id, input.hostId, input.conversationId, input.project, input.prompt, now, now);
    return this.getTask(id);
  }

  getTask(id) {
    return relayTaskFromRow(
      this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id),
    );
  }

  pendingTasks(hostId) {
    return this.database.prepare(`
      SELECT * FROM tasks
      WHERE host_id = ? AND status NOT IN ('completed', 'failed')
      ORDER BY created_at, id
    `).all(hostId).map(relayTaskFromRow);
  }

  updateTask(id, patch) {
    const allowed = new Map([
      ["status", "status"],
      ["threadId", "thread_id"],
      ["worktreePath", "worktree_path"],
      ["result", "result"],
      ["error", "error"],
    ]);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    if (entries.length === 0) {
      return this.getTask(id);
    }
    const assignments = entries.map(([key]) => `${allowed.get(key)} = ?`);
    const values = entries.map(([, value]) => value ?? null);
    assignments.push("updated_at = ?");
    values.push(this.now(), id);
    const result = this.database
      .prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values);
    if (result.changes === 0) {
      throw new Error(`Unknown task: ${id}`);
    }
    return this.getTask(id);
  }

  close() {
    this.database.close();
  }
}

function projectFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    alias: row.alias,
    root: row.root,
    permissions: row.permissions,
    codexProjectId: row.codex_project_id,
  };
}

function conversationFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    project: row.project,
    threadId: row.thread_id,
    worktreePath: row.worktree_path,
    sourceHead: row.source_head,
  };
}

function deliveryFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    taskId: row.task_id,
    conversationId: row.conversation_id,
    queuedSubmissionId: row.queued_submission_id,
    turnId: row.turn_id,
    status: row.status,
    result: row.result,
    error: row.error,
  };
}

export class HostStore {
  constructor(path, { now = () => Date.now() } = {}) {
    this.database = openDatabase(path);
    this.now = now;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        alias TEXT PRIMARY KEY,
        root TEXT NOT NULL UNIQUE,
        permissions TEXT NOT NULL,
        codex_project_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL REFERENCES projects(alias),
        thread_id TEXT NOT NULL UNIQUE,
        worktree_path TEXT NOT NULL UNIQUE,
        source_head TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        task_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        queued_submission_id TEXT,
        turn_id TEXT,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deliveries_conversation_status
        ON deliveries(conversation_id, status, created_at);
    `);
  }

  upsertProject({ alias, root, permissions = ":workspace" }) {
    const now = this.now();
    this.database.prepare(`
      INSERT INTO projects (alias, root, permissions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        root = excluded.root,
        permissions = excluded.permissions,
        codex_project_id = CASE
          WHEN projects.root = excluded.root THEN projects.codex_project_id
          ELSE NULL
        END,
        updated_at = excluded.updated_at
    `).run(alias, root, permissions, now, now);
    return this.getProject(alias);
  }

  getProject(alias) {
    return projectFromRow(
      this.database.prepare("SELECT * FROM projects WHERE alias = ?").get(alias),
    );
  }

  listProjects() {
    return this.database.prepare("SELECT * FROM projects ORDER BY alias").all().map(projectFromRow);
  }

  setCodexProjectId(alias, codexProjectId) {
    const result = this.database.prepare(`
      UPDATE projects SET codex_project_id = ?, updated_at = ? WHERE alias = ?
    `).run(codexProjectId, this.now(), alias);
    if (result.changes === 0) {
      throw new Error(`Unknown project: ${alias}`);
    }
    return this.getProject(alias);
  }

  getConversation(id) {
    return conversationFromRow(
      this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(id),
    );
  }

  createConversation({ id, project, threadId, worktreePath, sourceHead }) {
    const existing = this.getConversation(id);
    if (existing) {
      if (existing.project !== project) {
        throw new Error(
          `Conversation ${id} is already pinned to project ${existing.project}`,
        );
      }
      return existing;
    }
    const now = this.now();
    this.database.prepare(`
      INSERT INTO conversations (
        id, project, thread_id, worktree_path, source_head, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, project, threadId, worktreePath, sourceHead, now, now);
    return this.getConversation(id);
  }

  getDelivery(taskId) {
    return deliveryFromRow(
      this.database.prepare("SELECT * FROM deliveries WHERE task_id = ?").get(taskId),
    );
  }

  createDelivery({ taskId, conversationId }) {
    const now = this.now();
    this.database.prepare(`
      INSERT INTO deliveries (
        task_id, conversation_id, status, created_at, updated_at
      ) VALUES (?, ?, 'received', ?, ?)
      ON CONFLICT(task_id) DO NOTHING
    `).run(taskId, conversationId, now, now);
    return this.getDelivery(taskId);
  }

  updateDelivery(taskId, patch) {
    const allowed = new Map([
      ["queuedSubmissionId", "queued_submission_id"],
      ["turnId", "turn_id"],
      ["status", "status"],
      ["result", "result"],
      ["error", "error"],
    ]);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    if (entries.length === 0) {
      return this.getDelivery(taskId);
    }
    const assignments = entries.map(([key]) => `${allowed.get(key)} = ?`);
    const values = entries.map(([, value]) => value ?? null);
    assignments.push("updated_at = ?");
    values.push(this.now(), taskId);
    const result = this.database
      .prepare(`UPDATE deliveries SET ${assignments.join(", ")} WHERE task_id = ?`)
      .run(...values);
    if (result.changes === 0) {
      throw new Error(`Unknown delivery: ${taskId}`);
    }
    return this.getDelivery(taskId);
  }

  deliveryForTurn(turnId) {
    return deliveryFromRow(
      this.database.prepare("SELECT * FROM deliveries WHERE turn_id = ?").get(turnId),
    );
  }

  close() {
    this.database.close();
  }
}
