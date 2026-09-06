import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const VALID_MEMORY_MARKDOWN = `## Summary
A concise summary.

## What changed
- Added memory capture.

## Decisions
- Keep it local.

## Still unresolved
- Nothing.

## Important references
- The Synapse wiki.
`;

export async function createMemoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "synapse-memory-test-"));
  const projectRoot = join(directory, "project");
  const linkedWorktree = join(directory, "linked-worktree");
  const synapseHome = join(directory, "synapse-home");
  await mkdir(projectRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
  await execFileAsync("git", ["config", "user.name", "Synapse Test"], {
    cwd: projectRoot,
  });
  await execFileAsync("git", ["config", "user.email", "test@synapse.local"], {
    cwd: projectRoot,
  });
  await writeFile(join(projectRoot, "README.md"), "fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: projectRoot });
  await execFileAsync("git", ["commit", "-qm", "fixture"], {
    cwd: projectRoot,
  });
  await execFileAsync(
    "git",
    ["worktree", "add", "--detach", linkedWorktree, "HEAD"],
    {
      cwd: projectRoot,
    },
  );

  const hostDatabase = join(synapseHome, "host.sqlite");
  await mkdir(synapseHome, { recursive: true });
  const database = new DatabaseSync(hostDatabase);
  database.exec(`
    CREATE TABLE projects (
      alias TEXT PRIMARY KEY,
      root TEXT NOT NULL UNIQUE
    );
  `);
  database
    .prepare("INSERT INTO projects (alias, root) VALUES (?, ?)")
    .run("fixture", projectRoot);
  database.close();

  return {
    directory,
    env: {
      SYNAPSE_HOME: synapseHome,
      SYNAPSE_CHECKPOINT_INTERVAL: "3",
    },
    hostDatabase,
    linkedWorktree,
    projectRoot,
    synapseHome,
  };
}

export function registerProject(hostDatabase, alias, root) {
  const database = new DatabaseSync(hostDatabase);
  database
    .prepare("INSERT INTO projects (alias, root) VALUES (?, ?)")
    .run(alias, root);
  database.close();
}

export function readCheckpointSession(checkpointDatabase, sessionId) {
  const database = new DatabaseSync(checkpointDatabase, { readOnly: true });
  const session = database
    .prepare("SELECT * FROM checkpoint_sessions WHERE session_id = ?")
    .get(sessionId);
  database.close();
  return session;
}
