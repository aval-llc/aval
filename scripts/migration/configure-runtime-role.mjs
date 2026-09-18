#!/usr/bin/env node

/** Create or rotate the restricted login used by Cloudflare Hyperdrive. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const roleName = "aval_runtime";
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export async function configureRuntimeRole(connectionString, password, options = {}) {
  if (!connectionString) throw new Error("Set DATABASE_URL to the Supabase administrator connection string");
  if (!password || password.length < 24) throw new Error("AVAL_DATABASE_PASSWORD must contain at least 24 characters");
  const parsed = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("DATABASE_URL must be PostgreSQL");
  if (!options.allowRemote && !localHosts.has(parsed.hostname)) {
    throw new Error("Remote role configuration requires the explicit --allow-remote flag");
  }

  const client = new Client({ connectionString, application_name: "aval-runtime-setup", connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
    if (!exists.rowCount) {
      await client.query(`CREATE ROLE ${roleName} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }
    const passwordCommand = await client.query(
      "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS command",
      [roleName, password],
    );
    await client.query(passwordCommand.rows[0].command);
    await client.query(`GRANT aval_app, aval_worker TO ${roleName}`);
  } finally {
    await client.end();
  }
  return roleName;
}

async function main() {
  const role = await configureRuntimeRole(process.env.DATABASE_URL, process.env.AVAL_DATABASE_PASSWORD, {
    allowRemote: process.argv.includes("--allow-remote"),
  });
  console.log(`Configured restricted PostgreSQL login: ${role}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
