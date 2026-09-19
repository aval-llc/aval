#!/usr/bin/env node

/**
 * Write a generated migration, refusing to change one that has already shipped.
 *
 * `apply-supabase-migrations.mjs` records a sha256 per applied migration and
 * rejects one whose bytes have changed:
 *
 *   Applied migration 20260910000100 no longer matches
 *   20260910000100_postgres_backend.sql
 *
 * That is a deploy failure, not a warning, and it blocks every later migration
 * behind it. Both generators here write files that are already applied in
 * production — the baseline and the default-deny RLS file — so regenerating
 * after any schema change quietly produces a repository that cannot deploy.
 * It happened once; this turns it into an error at the point of writing, where
 * the fix is obvious, instead of in the production job twenty minutes later.
 *
 * A generator cannot ask the database what it has applied — it has no
 * connection string and runs in checkouts that were never deployed. The proxy
 * is the file on disk: if it exists and the new bytes differ, something that
 * may already be applied is being rewritten.
 *
 * The escape hatch is for the one case where rewriting is correct — the
 * database was reset, so nothing is applied and the file is free to change.
 * It is deliberately explicit, because "my generator output changed" and "I
 * reset production" should not look the same from here.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function rewriteAllowed(argv = process.argv) {
  return argv.includes("--allow-rewrite") || process.env.AVAL_ALLOW_MIGRATION_REWRITE === "1";
}

export class AppliedMigrationRewrite extends Error {
  constructor(file) {
    super(
      `Refusing to rewrite ${file}: it may already be applied.\n\n`
      + "apply-supabase-migrations.mjs protects applied migrations by hash, so changing\n"
      + "this file does not install anything — it fails the deploy and blocks every\n"
      + "migration after it. Put the change in a new timestamped migration instead:\n\n"
      + "  supabase/migrations/<UTC timestamp>_<name>.sql\n\n"
      + "New tables also need their row-level security there; the frozen RLS file\n"
      + "cannot carry it for them.\n\n"
      + "If the database was reset and nothing is applied, re-run with --allow-rewrite\n"
      + "or AVAL_ALLOW_MIGRATION_REWRITE=1.",
    );
    this.name = "AppliedMigrationRewrite";
    this.file = file;
  }
}

/**
 * @returns {Promise<"created"|"unchanged"|"rewritten">} what the write did, so
 * a caller can report honestly rather than always claiming it published.
 */
export async function writeMigration(target, contents, options = {}) {
  const normalised = contents.replaceAll("\r\n", "\n");
  let existing = null;
  try {
    existing = (await readFile(target, "utf8")).replaceAll("\r\n", "\n");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (existing === null) {
    await writeFile(target, normalised);
    return "created";
  }
  // Regenerating an unchanged file is how these scripts are normally run; only
  // a change to something already on disk is the dangerous case.
  if (existing === normalised) return "unchanged";
  if (!(options.allowRewrite ?? rewriteAllowed())) throw new AppliedMigrationRewrite(path.basename(target));

  await writeFile(target, normalised);
  return "rewritten";
}
