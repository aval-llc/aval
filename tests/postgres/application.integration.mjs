import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { and, eq } from "drizzle-orm";
import { properties } from "../../db/postgres/schema.ts";
import { withDbSession } from "../../db/postgres/session.ts";
import { runAuditCases } from "./audit-cases.mjs";
import { applySupabaseMigrations } from "../../scripts/migration/apply-supabase-migrations.mjs";

const url = process.env.AVAL_TEST_DATABASE_URL;
if (!url) throw new Error("Set AVAL_TEST_DATABASE_URL to a disposable local PostgreSQL database");
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(url).hostname)) {
  throw new Error("Application integration tests are restricted to loopback databases");
}

const personalOrganization = (subject) => `org_${createHash("sha256").update(subject).digest("hex").slice(0, 24)}`;

test("clean Supabase migrations support auth bootstrap, RLS isolation and rollback", async (t) => {
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const existing = await admin.query("SELECT to_regclass('public.properties') AS table_name");
  assert.equal(existing.rows[0].table_name, null, "Use a fresh disposable database");
  await admin.end();

  const first = await applySupabaseMigrations(url);
  assert.ok(first.discovered >= 8);
  assert.equal(first.applied.length, first.discovered);
  const replay = await applySupabaseMigrations(url);
  assert.deepEqual(replay.applied, [], "migration replay must be a no-op");

  const administrator = new Client({ connectionString: url });
  await administrator.connect();
  const loginName = `aval_mvp_${randomBytes(6).toString("hex")}`;
  const loginPassword = randomBytes(32).toString("base64url");
  let roleCreated = false;
  try {
    const createRole = await administrator.query(
      "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS command",
      [loginName, loginPassword],
    );
    await administrator.query(createRole.rows[0].command);
    roleCreated = true;
    await administrator.query(`GRANT aval_app, aval_worker TO "${loginName}"`);

    const appUrl = new URL(url);
    appUrl.username = loginName;
    appUrl.password = loginPassword;
    const config = { connectionString: appUrl.href };
    const userA = `user_${randomUUID()}`;
    const userB = `user_${randomUUID()}`;

    const session = (subject, work) => withDbSession(config, {
      principalId: subject,
      organizationId: personalOrganization(subject),
      actorId: subject,
      requestId: randomUUID(),
      auth: { userId: subject, email: `${subject}@example.test`, displayName: subject, source: "password" },
    }, work, {
      verifyCleanContext: true,
      initializeIdentity: async (client, identity) => {
        const result = await client.query(
          "SELECT aval_private.bootstrap_supabase_identity($1, $2, $3, true, $4, NULL) AS organization_id",
          [subject, `${subject}@example.test`, subject, personalOrganization(subject)],
        );
        return { ...identity, organizationId: result.rows[0].organization_id };
      },
    });

    await t.test("upgrading the deployed auth function repairs first login and repeat login", async () => {
      const originalMigration = await readFile(new URL("../../supabase/migrations/20260911000100_supabase_auth_runtime.sql", import.meta.url), "utf8");
      const originalFunction = originalMigration.match(/CREATE OR REPLACE FUNCTION aval_private\.bootstrap_supabase_identity\([\s\S]*?END \$\$;/)?.[0];
      assert.ok(originalFunction, "the deployed function is present in migration history");
      const repair = await readFile(new URL("../../supabase/migrations/20260912000200_auth_identity_conflict.sql", import.meta.url), "utf8");
      const subject = `upgrade_${randomUUID()}`;
      const organization = personalOrganization(subject);
      const bootstrap = "SELECT aval_private.bootstrap_supabase_identity($1, $2, $3, true, $4, NULL) AS organization_id";
      const values = [subject, `${subject}@example.test`, "Auth upgrade check", organization];
      await administrator.query("BEGIN");
      try {
        await administrator.query(originalFunction);
        await administrator.query("SET LOCAL ROLE aval_app");
        await administrator.query("SELECT set_config('aval.principal_id', $1, true), set_config('aval.organization_id', $2, true)", [subject, organization]);
        await administrator.query("SAVEPOINT before_login");
        await assert.rejects(administrator.query(bootstrap, values), { code: "42702" });
        await administrator.query("ROLLBACK TO SAVEPOINT before_login");
        await administrator.query("RESET ROLE");
        await administrator.query(repair);
        await administrator.query("SET LOCAL ROLE aval_app");
        assert.equal((await administrator.query(bootstrap, values)).rows[0].organization_id, organization);
        assert.equal((await administrator.query(bootstrap, values)).rows[0].organization_id, organization);
        await administrator.query("RESET ROLE");
        const linked = await administrator.query("SELECT count(*)::int AS count FROM public.identity_links WHERE provider = 'supabase' AND subject = $1", [subject]);
        assert.equal(linked.rows[0].count, 1, "retrying login must preserve one identity link");
      } finally {
        await administrator.query("ROLLBACK");
      }
    });

    const propertyId = `property_${randomUUID()}`;
    await session(userA, async (dbSession) => {
      const now = new Date();
      await dbSession.db.insert(properties).values({
        id: propertyId,
        organizationId: dbSession.identity.organizationId,
        name: "MVP Property",
        createdAt: now,
        updatedAt: now,
      });
      const rows = await dbSession.db.select().from(properties).where(eq(properties.id, propertyId));
      assert.equal(rows.length, 1);
    });

    await session(userB, async (dbSession) => {
      const invisible = await dbSession.db.select().from(properties).where(eq(properties.id, propertyId));
      assert.equal(invisible.length, 0, "another organization cannot read the row");
    });
    await assert.rejects(
      session(userB, (dbSession) =>
        dbSession.db.insert(properties).values({
          id: `forged_${randomUUID()}`,
          organizationId: personalOrganization(userA),
          name: "Forged Property",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ),
      (error) => error?.cause?.code === "42501" || error?.code === "42501",
    );

    const rollbackId = `rollback_${randomUUID()}`;
    await assert.rejects(session(userA, async (dbSession) => {
      const now = new Date();
      await dbSession.db.insert(properties).values({
        id: rollbackId,
        organizationId: dbSession.identity.organizationId,
        name: "Must roll back",
        createdAt: now,
        updatedAt: now,
      });
      throw new Error("intentional rollback");
    }), /intentional rollback/);
    const rolledBack = await administrator.query("SELECT id FROM public.properties WHERE id = $1", [rollbackId]);
    assert.equal(rolledBack.rowCount, 0);

    const ownRows = await session(userA, (dbSession) => dbSession.db.select().from(properties)
      .where(and(eq(properties.organizationId, personalOrganization(userA)), eq(properties.id, propertyId))));
    assert.equal(ownRows.length, 1);
    await runAuditCases(t, { config, administrator, userId: userA, invitedUserId: userB, organizationId: personalOrganization(userA) });
  } finally {
    if (roleCreated) {
      await administrator.query(`REVOKE aval_app, aval_worker FROM "${loginName}"`).catch(() => undefined);
      await administrator.query(`DROP ROLE "${loginName}"`).catch(() => undefined);
    }
    await administrator.end();
  }
});
