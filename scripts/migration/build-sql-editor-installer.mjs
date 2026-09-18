#!/usr/bin/env node

/** Build one atomic SQL file for installing every checked-in migration in Supabase's SQL editor. */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDirectory = path.join(root, "supabase", "migrations");
const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "supabase", "aval-sql-editor-installer.sql");

const files = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
  .sort();

if (files.length === 0) throw new Error("No Supabase migrations were found");

const sections = [
  "-- Generated installer for Supabase SQL Editor. Do not edit by hand.",
  "BEGIN;",
  "CREATE SCHEMA IF NOT EXISTS aval_migrations;",
  `CREATE TABLE IF NOT EXISTS aval_migrations.schema_migrations (
  version text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
);`,
];

for (const file of files) {
  const version = file.slice(0, file.indexOf("_"));
  const sql = (await readFile(path.join(migrationsDirectory, file), "utf8")).replaceAll("\r\n", "\n");
  const sha256 = createHash("sha256").update(sql).digest("hex");
  sections.push(
    `-- Begin ${file}`,
    sql.trimEnd(),
    `INSERT INTO aval_migrations.schema_migrations(version, sha256) VALUES ('${version}', '${sha256}');`,
    `-- End ${file}`,
  );
}

sections.push("COMMIT;", "");
await writeFile(outputPath, sections.join("\n\n"));
console.log(JSON.stringify({ output: outputPath, migrations: files.length }));
