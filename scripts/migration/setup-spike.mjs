import { Client } from "pg";
import { readFile } from "node:fs/promises";

const url = process.env.AVAL_BENCHMARK_ADMIN_URL;
if (!url) throw new Error("Set AVAL_BENCHMARK_ADMIN_URL in the private migration environment file");
let destination;
try { destination = new URL(url); }
catch { throw new Error("AVAL_BENCHMARK_ADMIN_URL is not a valid database URL"); }
if (!["postgres:", "postgresql:"].includes(destination.protocol)) throw new Error("Expected a PostgreSQL connection URL");
if (!["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname)
    && process.env.AVAL_BENCHMARK_DEDICATED_PROJECT !== "yes") {
  throw new Error("Remote spike setup requires AVAL_BENCHMARK_DEDICATED_PROJECT=yes for an isolated fixture project");
}
const password = process.env.AVAL_BENCHMARK_DB_PASSWORD;
if (!password || password.length < 32) throw new Error("Set a random benchmark database password of at least 32 characters");
const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query("BEGIN");
  const existing = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'aval_benchmark'");
  if (existing.rows.length) throw new Error("Spike already exists; reuse it, or create a fresh benchmark database. This command never resets a database.");
  const migration = await readFile(new URL("../../supabase/benchmark/001_spike.sql", import.meta.url), "utf8");
  await client.query(migration.replace(/^BEGIN;\r?$/m, "").replace(/^COMMIT;\r?$/m, ""));
  // quote_literal is computed by Postgres, not shell interpolation. Never log this SQL.
  const { rows } = await client.query("SELECT format('CREATE ROLE aval_benchmark_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 15 PASSWORD %L', $1::text) AS command", [password]);
  await client.query(rows[0].command);
  await client.query("GRANT aval_benchmark_app TO aval_benchmark_login");
  await client.query("COMMIT");
  console.log("Created isolated fixture schema and restricted benchmark login (10 organizations, 10000 properties/tasks).");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* Discard the connection. */ }
  // Role commands contain credentials; never print the raw pg error or its query.
  if (error?.code) throw new Error(`Spike setup failed (PostgreSQL ${error.code}); inspect destination state before retrying`);
  throw error;
} finally { await client.end(); }
