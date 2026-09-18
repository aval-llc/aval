import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { withDbSession } from "../../db/postgres/session.ts";
import { auditedWrite, claimTask, checkpoint, listProperties } from "../../infra/benchmark/operations.ts";
import worker from "../../infra/benchmark/worker.ts";

const url = process.env.AVAL_TEST_DATABASE_URL;
// Explicitly invoked DB suite fails without a DB; it must never silently pass via skipped tests.
if (!url) throw new Error("Set AVAL_TEST_DATABASE_URL to a disposable local PostgreSQL/Supabase database");
if (!["127.0.0.1","localhost","[::1]"].includes(new URL(url).hostname)) throw new Error("Destructive fixture tests are restricted to loopback databases");

test("PostgreSQL transaction, RLS, audit and lease guarantees", async (t) => {
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const schemaExists = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='aval_benchmark'");
  assert.equal(schemaExists.rows.length, 0, "Use a fresh database; tests never destroy an existing schema");
  const loginPassword = randomBytes(32).toString("hex");
  const loginName = `aval_benchmark_test_${randomBytes(6).toString("hex")}`;
  let createdLogin = false;
  try {
    await admin.query(await readFile(new URL("../../supabase/benchmark/001_spike.sql", import.meta.url), "utf8"));
    const login = await admin.query("SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS command", [loginName, loginPassword]);
    await admin.query(login.rows[0].command);
    createdLogin = true;
    await admin.query(`GRANT aval_benchmark_app TO "${loginName}"`);
    const appUrl = new URL(url); appUrl.username = loginName; appUrl.password = loginPassword;
    const config = { connectionString: appUrl.href };
    const identity = (org = 0, requestId = randomUUID()) => ({ organizationId: `bench_org_${org}`, principalId: `principal_bench_org_${org}`, actorId: `principal_bench_org_${org}`, requestId });
    const session = (id, work) => withDbSession(config, id, work, { role: "aval_benchmark_app", verifyCleanContext: true });

    await t.test("missing context, guessed tenant, revoked membership, role escalation and public headers are denied", async () => {
      const raw = new Client(config); await raw.connect();
      try {
        await assert.rejects(raw.query("SELECT * FROM aval_benchmark.properties"), { code: "42501" });
        await raw.query("BEGIN"); await raw.query("SET LOCAL ROLE aval_benchmark_app");
        assert.equal((await raw.query("SELECT * FROM aval_benchmark.properties")).rowCount, 0);
        await assert.rejects(raw.query("SET LOCAL ROLE postgres"), { code: "42501" });
        await raw.query("ROLLBACK");
      } finally { await raw.end(); }
      assert.equal((await session({ ...identity(0), organizationId: "bench_org_1" }, listProperties)).length, 0);
      await admin.query("UPDATE aval_benchmark.members SET revoked_at=now() WHERE organization_id='bench_org_0'");
      assert.equal((await session(identity(), listProperties)).length, 0);
      await admin.query("UPDATE aval_benchmark.members SET revoked_at=NULL WHERE organization_id='bench_org_0'");
      const response = await worker.fetch(new Request("https://example.test/list", { method: "POST", headers: { "oai-authenticated-user-id": "principal_bench_org_0" } }), { BENCHMARK_TOKEN: "x".repeat(32) });
      assert.equal(response.status, 401);
    });
    await t.test("concurrent alternating tenants cannot see another tenant's rows or leak context", async () => {
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => session(identity(i%10), async (s) => {
        const visible = await s.db.execute(sql`SELECT DISTINCT organization_id FROM aval_benchmark.properties`);
        assert.deepEqual(visible.rows.map((r) => r.organization_id), [s.identity.organizationId]);
        const role = await s.db.execute(sql`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`);
        assert.deepEqual(role.rows[0], {rolbypassrls:false, rolsuper:false});
        return listProperties(s);
      })));
      assert.ok(results.every((r) => r.length === 50));
    });
    await t.test("cross-organization foreign keys fail even through an administrator connection", async () => {
      await assert.rejects(admin.query("INSERT INTO aval_benchmark.agent_tasks(id,organization_id,property_id) VALUES ('cross-tenant','bench_org_0','bench_org_1_property_00001')"), { code: "23503" });
    });
    await t.test("failed audit rolls back its business mutation and the next session starts clean", async () => {
      await assert.rejects(session(identity(), (s) => auditedWrite(s, true)), /Injected audit failure/);
      assert.equal((await admin.query("SELECT revision::text FROM aval_benchmark.properties WHERE id='bench_org_0_property_00001'")).rows[0].revision, "0");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM aval_benchmark.answer_audit_log")).rows[0].n, 0);
      assert.equal((await session(identity(), listProperties)).length, 50);
    });
    await t.test("concurrent audit writes stay contiguous and duplicate requests create one effect", async () => {
      await Promise.all(Array.from({length: 20}, () => session(identity(), auditedWrite)));
      const id = identity();
      await Promise.all(Array.from({length: 5}, () => session(id, auditedWrite)));
      const entries = (await admin.query("SELECT * FROM aval_benchmark.answer_audit_log WHERE organization_id='bench_org_0' ORDER BY sequence")).rows;
      assert.equal(entries.length, 21);
      let previous = "GENESIS";
      for (const [i, row] of entries.entries()) {
        assert.equal(row.sequence, String(i+1)); assert.equal(row.previous_hash, previous);
        const hash = createHash("sha256").update([row.sequence,previous,row.payload_digest,row.request_id].join("\u001f")).digest("hex");
        assert.equal(row.entry_hash, hash); previous = hash;
      }
      assert.equal((await admin.query("SELECT revision::text FROM aval_benchmark.properties WHERE id='bench_org_0_property_00001'")).rows[0].revision, "21");
      const observed = await session(id, (s) => s.db.execute(sql`SELECT count(*)::int AS n FROM aval_benchmark.answer_audit_log WHERE request_id = ${id.requestId}`));
      assert.equal(observed.rows[0].n, 1);
      await assert.rejects(admin.query("DELETE FROM aval_benchmark.answer_audit_log WHERE organization_id='bench_org_0'"), {code: "23514"});
    });
    await t.test("SKIP LOCKED gives each worker a unique task generation; expired workers cannot checkpoint", async () => {
      const claims = await Promise.all(Array.from({length: 30}, () => session(identity(), claimTask)));
      assert.ok(claims.every(Boolean)); assert.equal(new Set(claims.map((c) => `${c.id}/${c.lease_generation}`)).size, 30);
      const task = claims.sort((a,b) => a.id.localeCompare(b.id))[0];
      const token = {id:task.id, generation:task.lease_generation, owner:task.lease_owner};
      assert.equal(await session(identity(), (s) => checkpoint(s, token)), true);
      await admin.query("UPDATE aval_benchmark.agent_tasks SET lease_expires_at=now()-interval '1 second', next_run_at=now()-interval '1 hour' WHERE id=$1", [task.id]);
      assert.equal(await session(identity(), (s) => checkpoint(s, token)), false);
      const fresh = await session(identity(), claimTask);
      assert.equal(fresh.id, task.id); assert.equal(BigInt(fresh.lease_generation), BigInt(task.lease_generation)+BigInt(1));
      assert.equal(await session(identity(), (s) => checkpoint(s, token)), false);
      assert.equal(await session(identity(), (s) => checkpoint(s, {id:fresh.id,generation:fresh.lease_generation,owner:fresh.lease_owner})), true);
    });
  } finally {
    try { if (createdLogin) await admin.query(`DROP ROLE "${loginName}"`); }
    finally { await admin.end(); }
  }
  // Leave fixtures for inspection. The caller owns the disposable database lifecycle.
});
