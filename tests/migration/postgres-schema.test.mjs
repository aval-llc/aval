import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * Every checked-in Supabase migration, concatenated in apply order.
 *
 * The baseline and the default-deny RLS file are both applied in production and
 * apply-supabase-migrations.mjs protects applied migrations by hash, so neither
 * can absorb a new table any more. A table added after that freeze arrives in
 * its own timestamped migration, and these invariants have to hold across the
 * set that actually installs the schema rather than across one file that no
 * longer can.
 */
async function allMigrations() {
  const directory = path.join(root, "supabase/migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const parts = await Promise.all(files.map((name) => readFile(path.join(directory, name), "utf8")));
  return parts.join("\n");
}

test("clean PostgreSQL baseline covers the current inventory with deliberate native types", async () => {
  const [inventoryRaw, baseline, migrations] = await Promise.all([
    read("docs/migration/inventory.json"),
    read("supabase/migrations/20260910000100_postgres_backend.sql"),
    allMigrations(),
  ]);
  const inventory = JSON.parse(inventoryRaw);
  const expected = inventory.tables.map((table) => table.name).sort();
  // Migrations also create tables the ORM never models (a quarantine store, an
  // inbox cursor); those are outside the inventory and not this assertion's
  // business. What matters is that nothing the ORM models goes uninstalled.
  const created = new Set([...migrations.matchAll(/CREATE TABLE (?:public\.)?"([^"]+)"/g)].map((match) => match[1]));
  const actual = expected.filter((name) => created.has(name));

  assert.deepEqual(actual, expected);
  assert.match(baseline, /timestamp with time zone/);
  assert.match(baseline, /jsonb/);
  assert.match(baseline, /bigint/);
  assert.match(baseline, /numeric\(20, 6\)/);
  assert.doesNotMatch(baseline, /legacy_id_map|uuid_generate|gen_random_uuid/i);
  assert.match(baseline, /CONSTRAINT "access_grants_org_property_fk" FOREIGN KEY \("organization_id","property_id"\) REFERENCES "public"\."properties"\("organization_id","id"\)/);
  const firstForeignKey = baseline.indexOf("ALTER TABLE ");
  const uniqueIndexes = [...baseline.matchAll(/^CREATE UNIQUE INDEX /gm)];
  assert.ok(firstForeignKey > 0 && uniqueIndexes.length > 0);
  assert.ok(uniqueIndexes.every((match) => match.index < firstForeignKey), "unique indexes must exist before composite foreign keys reference them");
});

test("RLS covers every organization table and keeps organization roles organization-scoped", async () => {
  const [inventoryRaw, rls, migrations] = await Promise.all([
    read("docs/migration/inventory.json"),
    read("supabase/migrations/20260910000200_default_deny_rls.sql"),
    allMigrations(),
  ]);
  const inventory = JSON.parse(inventoryRaw);
  const tenantTables = inventory.tables
    .filter((table) => table.columns.some((column) => column.name === "organization_id"))
    .map((table) => table.name);

  for (const table of tenantTables) {
    assert.ok(migrations.includes(`ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY;`), `missing FORCE RLS for ${table}`);
  }
  assert.match(rls, /grant_row\.role = ANY\(allowed_roles\)\s+AND grant_row\.organization_scope/);
  assert.match(rls, /CREATE POLICY "properties_insert"[\s\S]*?WITH CHECK \(aval_private\.has_org_role\(organization_id, ARRAY\['org_admin'\]\)\);/);
  assert.match(rls, /cannot remove the final organization administrator/);
});
