import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildInventory, readHistory, productionPreflightSql } from "../../scripts/migration/inventory.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("inventory replays every checked-in migration, captures triggers and generates executable count queries", async () => {
  const inventory = await buildInventory(root);
  const history = await readHistory(root);
  assert.equal(inventory.counts.migrations, history.migrations.length);
  assert.ok(inventory.tables.some((t) => t.name === "agent_model_contexts"));
  assert.ok(inventory.triggers.some((t) => t.name === "agent_memory_no_update"));
  assert.deepEqual(inventory.consumers, [], "application runtime must not retain a D1 consumer");
  assert.equal(new Set(inventory.tables.map((t) => t.name)).size, inventory.counts.tables);
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of history.migrations) db.exec(migration.sql);
    db.exec(productionPreflightSql(inventory));
    assert.equal(db.prepare("SELECT count(*) AS n FROM users").get().n, 0);
  } finally { db.close(); }
});

test("inventory refuses missing, orphaned and reordered migrations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aval-migration-inventory-"));
  try {
    await mkdir(path.join(directory, "drizzle/meta"), { recursive: true });
    const journal = { dialect: "sqlite", entries: [{idx: 0, tag: "0000_test"}] };
    const journalFile = path.join(directory, "drizzle/meta/_journal.json");
    await writeFile(journalFile, JSON.stringify(journal));
    await assert.rejects(readHistory(directory), /disagree/);
    await writeFile(path.join(directory, "drizzle/0000_test.sql"), "SELECT 1;");
    assert.equal((await readHistory(directory)).migrations.length, 1);
    await writeFile(path.join(directory, "drizzle/0001_orphan.sql"), "SELECT 1;");
    await assert.rejects(readHistory(directory), /disagree/);
    journal.entries[0].idx = 2;
    await writeFile(journalFile, JSON.stringify(journal));
    await assert.rejects(readHistory(directory), /order/);
  } finally {
    // mkdtemp returned this exact task-owned directory; never delete a supplied path.
    if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("aval-migration-inventory-")) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
