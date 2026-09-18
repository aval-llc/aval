#!/usr/bin/env node

/** Apply Aval's checked-in SQL migrations with hash-based replay protection. */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const root = fileURLToPath(new URL("../../", import.meta.url));
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export async function applySupabaseMigrations(connectionString, options = {}) {
  if (!connectionString) throw new Error("Set DATABASE_URL or AVAL_TEST_DATABASE_URL");
  const parsed = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("The migration URL must be PostgreSQL");
  if (!options.allowRemote && !localHosts.has(parsed.hostname)) {
    throw new Error("Remote migration requires the explicit --allow-remote flag");
  }

  const migrationsDirectory = path.join(root, "supabase", "migrations");
  const files = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  if (files.length === 0) throw new Error("No Supabase migrations were found");

  const client = new Client({ connectionString, application_name: "aval-migrations", connectionTimeoutMillis: 10_000 });
  await client.connect();
  const applied = [];
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS aval_migrations");
    await client.query(`CREATE TABLE IF NOT EXISTS aval_migrations.schema_migrations (
      version text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
    )`);

    for (const file of files) {
      const version = file.slice(0, file.indexOf("_"));
      const sql = (await readFile(path.join(migrationsDirectory, file), "utf8")).replaceAll("\r\n", "\n");
      const sha256 = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(
        "SELECT sha256 FROM aval_migrations.schema_migrations WHERE version = $1",
        [version],
      );
      if (existing.rowCount) {
        if (existing.rows[0].sha256 !== sha256) throw new Error(`Applied migration ${version} no longer matches ${file}`);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO aval_migrations.schema_migrations(version, sha256) VALUES ($1, $2)",
          [version, sha256],
        );
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new AggregateError([error], `Migration failed: ${file}`);
      }
    }
  } finally {
    await client.end();
  }
  return { discovered: files.length, applied };
}

async function main() {
  const connectionString = process.env.DATABASE_URL ?? process.env.AVAL_TEST_DATABASE_URL;
  const result = await applySupabaseMigrations(connectionString, { allowRemote: process.argv.includes("--allow-remote") });
  console.log(JSON.stringify({ migrations: result.discovered, applied: result.applied }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
