import { execFile } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const PROJECT_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{1,62}$/;

function resolveGitPath(projectRoot, path) {
  return isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
}

export async function resolveProjectRoot(
  project,
  cwd = process.cwd(),
  { execGit = execFileAsync } = {},
) {
  let candidate;
  if (isAbsolute(project)) {
    candidate = project;
  } else if (project === "." || project === basename(resolve(cwd))) {
    candidate = cwd;
  } else {
    throw new Error(
      `Project ${project} is not the current folder; pass its absolute path instead`,
    );
  }
  let stdout;
  try {
    ({ stdout } = await execGit(
      "git",
      [
        "-C",
        resolve(candidate),
        "rev-parse",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      { encoding: "utf8" },
    ));
  } catch {
    throw new Error(`Project is not a Git checkout: ${resolve(candidate)}`);
  }
  const [root, gitDirectory, commonDirectory] = stdout.trim().split("\n");
  const projectRoot = resolve(root);
  if (
    resolveGitPath(projectRoot, gitDirectory) !==
    resolveGitPath(projectRoot, commonDirectory)
  ) {
    throw new Error(
      `Project must be its primary checkout, not a linked worktree: ${projectRoot}`,
    );
  }
  return projectRoot;
}

export function hostDatabasePath(env = process.env) {
  const synapseHome = resolve(env.SYNAPSE_HOME ?? join(homedir(), ".synapse"));
  return resolve(env.SYNAPSE_HOST_DB ?? join(synapseHome, "host.sqlite"));
}

export async function connectProject(
  { alias, project = ".", cwd = process.cwd() },
  { env = process.env, resolveRoot = resolveProjectRoot } = {},
) {
  const normalizedAlias = String(alias ?? "")
    .trim()
    .toLowerCase();
  if (!PROJECT_ALIAS_PATTERN.test(normalizedAlias)) {
    throw new Error(
      "Project alias must be 2-63 lowercase characters starting with a letter",
    );
  }
  const root = await resolveRoot(project, cwd);
  const path = hostDatabasePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (
        alias TEXT PRIMARY KEY,
        root TEXT NOT NULL UNIQUE
      );
    `);
    const byAlias = database
      .prepare("SELECT alias, root FROM projects WHERE alias = ?")
      .get(normalizedAlias);
    const byRoot = database
      .prepare("SELECT alias, root FROM projects WHERE root = ?")
      .get(root);
    if (byAlias && byAlias.root !== root) {
      throw new Error(`Project alias ${normalizedAlias} is already connected`);
    }
    if (byRoot && byRoot.alias !== normalizedAlias) {
      throw new Error(`Project is already connected as ${byRoot.alias}`);
    }
    if (!byAlias && !byRoot) {
      database
        .prepare("INSERT INTO projects (alias, root) VALUES (?, ?)")
        .run(normalizedAlias, root);
    }
    return {
      alias: normalizedAlias,
      root,
      database: path,
      created: !byAlias && !byRoot,
    };
  } finally {
    database.close();
  }
}
