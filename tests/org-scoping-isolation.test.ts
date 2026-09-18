import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The org-scoping isolation test — renamed from "RLS isolation test", because
 * this codebase cannot have RLS.
 *
 * `docs/WHATSAPP_AGENT_DISCOVERY.md` established the constraint: the store is
 * Cloudflare D1, which is SQLite, which has no row-level security — no policies,
 * no per-connection session variables. Tenant isolation is enforced **only in
 * application code**. There is an in-flight Postgres + RLS spike in-repo; it is
 * not shipped.
 *
 * This test is deliberately weaker than RLS and the weakness is worth naming:
 * RLS holds for every query including ones nobody thought about, while this
 * holds for the queries it can see. What makes it more than a spot-check is that
 * it reads the module sources rather than exercising a hand-picked list of
 * tables — the discovery doc's specific criticism of the per-table approach was
 * that "it depends on a test remembering to cover a table". A new file under
 * lib/pms/ is covered the moment it is written.
 *
 * **This is a merge gate, not a solution.** Moving to Postgres with real RLS is
 * the actual fix. If this test is still the only thing standing between two
 * customers' work orders in six months, that is a finding.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Modules whose every storage read and write must be org-scoped. */
const SCOPED_DIRECTORIES = ["lib/pms"];

function sourceFiles(directory: string): string[] {
  const base = `${ROOT}${directory}`;
  const found: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path)) {
      const full = `${path}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) found.push(full);
    }
  };
  walk(base);
  return found;
}

test("every storage query in the PMS layer filters by organization", () => {
  // The failure this prevents: a query that reads `pms_write_authorizations` by
  // (provider, action) alone would hand one workspace another's authorization to
  // write into a PMS. On D1 nothing below the application stops that.
  const offenders: string[] = [];

  for (const directory of SCOPED_DIRECTORIES) {
    for (const file of sourceFiles(directory)) {
      const source = readFileSync(file, "utf8");
      // Each `.from(table)` begins a query; the statement it belongs to must
      // mention organizationId somewhere before it ends.
      const statements = source.split(/;\s*\n/);
      for (const statement of statements) {
        const touchesStorage = /\.from\(|\.insert\(|\.update\(|\.delete\(/.test(statement);
        if (!touchesStorage) continue;
        // A registry-only module may name a table in a type position.
        if (!/\bdb\b|getDb\(\)/.test(statement)) continue;
        if (!/organizationId/.test(statement)) {
          offenders.push(`${file.replace(ROOT, "")}: ${statement.trim().slice(0, 120)}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `unscoped storage access:\n${offenders.join("\n")}`);
});

test("the PMS write queue is keyed so one workspace's idempotency key cannot collide with another's", () => {
  // A globally unique idempotency key would let one workspace's retry suppress
  // another's write. The index is (organizationId, idempotencyKey).
  const schema = readFileSync(`${ROOT}db/schema.ts`, "utf8");
  const queueBlock = schema.slice(schema.indexOf('"pms_write_queue"'));
  assert.match(
    queueBlock,
    /uniqueIndex\("pms_write_queue_idem_uq"\)\.on\(table\.organizationId, table\.idempotencyKey\)/,
    "the write queue's idempotency index is not org-scoped",
  );
});

const TENANT_PMS_TABLES = [
  "pms_write_authorizations",
  "pms_action_flows",
  "pms_write_queue",
  "pms_seat_senders",
  "pms_seat_messages",
];

test("every new PMS table carries an organization column and scopes its unique indexes", () => {
  const schema = readFileSync(`${ROOT}db/schema.ts`, "utf8");
  for (const table of TENANT_PMS_TABLES) {
    const start = schema.indexOf(`"${table}"`);
    assert.ok(start > 0, `${table} is missing from the schema`);
    const block = schema.slice(start, schema.indexOf("\n);", start));
    assert.match(block, /organization_id/, `${table} has no organization column`);
    // Any unique index on a tenant table must lead with the organization, or it
    // is a cross-tenant constraint.
    for (const match of block.matchAll(/uniqueIndex\("[^"]+"\)\.on\(([^)]*)\)/g)) {
      assert.match(
        match[1],
        /^\s*table\.organizationId/,
        `${table} has a unique index that is not scoped to an organization: ${match[0]}`,
      );
    }
  }
});

test("a tenant table's primary key is one Aval constructs, never a value two tenants could share", () => {
  // Added after `pms_seat_messages` shipped with `digest` — a content hash — as
  // its primary key. Two workspaces can be sent the same bytes: one vendor
  // notice to both seats. The second row would have overwritten the first and
  // taken its organization_id with it, and the unique-index rule above could not
  // see it, because a primary key is not a uniqueIndex() call.
  //
  // `id` is the whole allowance: a key this codebase builds, which it can scope.
  const schema = readFileSync(`${ROOT}db/schema.ts`, "utf8");
  for (const table of TENANT_PMS_TABLES) {
    const start = schema.indexOf(`"${table}"`);
    const block = schema.slice(start, schema.indexOf("\n);", start));
    for (const match of block.matchAll(/(\w+):\s*text\("([^"]+)"\)[^,\n]*\.primaryKey\(\)/g)) {
      assert.equal(
        match[2],
        "id",
        `${table}'s primary key is \`${match[2]}\`, which is data rather than a key Aval constructs`,
      );
    }
  }
});

test("the isolation weakness is documented rather than assumed away", () => {
  // If someone deletes the note, this test is the thing that notices. A control
  // whose limitations are undocumented becomes a control people over-trust.
  const discovery = readFileSync(`${ROOT}docs/PMS_INTEGRATION_DISCOVERY.md`, "utf8");
  assert.match(discovery, /no row-level security|has no RLS|cannot have RLS/i);
  assert.match(discovery, /Postgres/i);
});
