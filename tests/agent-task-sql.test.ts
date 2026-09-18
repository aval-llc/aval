import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { latestApprovalSettledPredicate } from "../lib/agents/task-sql.ts";

const NOW = new Date(1_800_000_000_000);

/** The production predicate must remain PostgreSQL-native and parameterized. */
test("approval wake-up SQL binds a timestamptz without interpolating user data", () => {
  const query = new PgDialect().sqlToQuery(latestApprovalSettledPredicate(NOW));
  assert.match(query.sql, /agent_approvals/);
  assert.match(query.sql, /max\(a2\.step_index\)/);
  assert.match(query.sql, /a\.expires_at < \$1/);
  assert.deepEqual(query.params, [NOW]);
  assert.ok(!query.sql.includes(NOW.toISOString()));
});
