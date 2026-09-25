import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppliedMigrationRewrite, writeMigration } from "../../scripts/migration/write-migration.mjs";

/**
 * The guard on regenerating a migration that production may already hold.
 *
 * A changed byte in an applied migration is a deploy failure — the applier
 * compares sha256 and refuses the file — so the interesting assertion is the
 * refusal, and that the file on disk is left alone when it refuses.
 */

const scratch = async () => path.join(await mkdtemp(path.join(tmpdir(), "aval-migration-")), "0001_thing.sql");

test("a migration that does not exist yet is written", async () => {
  const target = await scratch();
  assert.equal(await writeMigration(target, "CREATE TABLE a();\n"), "created");
  assert.equal(await readFile(target, "utf8"), "CREATE TABLE a();\n");
});

test("regenerating identical content is a no-op, because that is the normal run", async () => {
  const target = await scratch();
  await writeFile(target, "CREATE TABLE a();\n");
  assert.equal(await writeMigration(target, "CREATE TABLE a();\n"), "unchanged");
});

test("line endings alone are not a change, matching how the applier hashes", async () => {
  // apply-supabase-migrations.mjs normalises \r\n before sha256, so a checkout
  // on Windows must not look like a rewrite of an applied migration.
  const target = await scratch();
  await writeFile(target, "CREATE TABLE a();\r\nCREATE TABLE b();\r\n");
  assert.equal(await writeMigration(target, "CREATE TABLE a();\nCREATE TABLE b();\n"), "unchanged");
});

test("changing a migration that may be applied is refused, and leaves the file alone", async () => {
  const target = await scratch();
  await writeFile(target, "CREATE TABLE a();\n");
  await assert.rejects(
    () => writeMigration(target, "CREATE TABLE a();\nCREATE TABLE b();\n", { allowRewrite: false }),
    (error) => {
      assert.ok(error instanceof AppliedMigrationRewrite);
      // The message has to carry the way out, or it just moves the confusion.
      assert.match(error.message, /new timestamped migration/);
      assert.match(error.message, /--allow-rewrite/);
      return true;
    },
  );
  assert.equal(await readFile(target, "utf8"), "CREATE TABLE a();\n", "the refused write must not land");
});

test("an explicit override rewrites, for a database that was reset", async () => {
  const target = await scratch();
  await writeFile(target, "CREATE TABLE a();\n");
  assert.equal(await writeMigration(target, "CREATE TABLE b();\n", { allowRewrite: true }), "rewritten");
  assert.equal(await readFile(target, "utf8"), "CREATE TABLE b();\n");
});
