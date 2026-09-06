import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { databaseSsl } from "../src/database-ssl.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDirectory = resolve(repositoryRoot, "supabase", "migrations");

export async function runMigrations({
  connectionString,
  ssl = databaseSsl(),
  directory = defaultDirectory,
  output = process.stdout,
}) {
  if (!connectionString) throw new Error("DATABASE_ADMIN_URL is required");
  const pool = new pg.Pool({ connectionString, ssl, max: 1 });
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query(
      "select pg_advisory_lock(hashtext('synapse_schema_migrations'))",
    );
    await client.query("create schema if not exists synapse_migrations");
    await client.query("revoke all on schema synapse_migrations from public");
    await client.query(`
      create table if not exists synapse_migrations.versions (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const files = (await readdir(directory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const existing = await client.query(
        "select 1 from synapse_migrations.versions where version = $1",
        [file],
      );
      if (existing.rowCount > 0) continue;
      const sql = await readFile(resolve(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "insert into synapse_migrations.versions (version) values ($1)",
          [file],
        );
        await client.query("COMMIT");
        applied.push(file);
        output.write(`Applied ${file}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      await client.query(
        "select pg_advisory_unlock(hashtext('synapse_schema_migrations'))",
      );
    } finally {
      client.release();
      await pool.end();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations({
    connectionString: process.env.DATABASE_ADMIN_URL,
    ssl: databaseSsl(process.env),
  }).catch((error) => {
    process.stderr.write(`Migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
