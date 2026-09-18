import { sql } from "drizzle-orm";
import type { DbSession } from "../../db/postgres/session.ts";

export async function listProperties(session: DbSession) {
  // The RLS tests deliberately omit an organization predicate elsewhere.
  const result = await session.db.execute(sql`SELECT id, organization_id, name, status,
    acquisition_cost_cents::text, attributes, revision::text
    FROM aval_benchmark.properties
    WHERE organization_id = ${session.identity.organizationId} AND status = 'active'
    ORDER BY id LIMIT 50`);
  return result.rows;
}

export async function claimTask(session: DbSession) {
  const result = await session.db.execute(sql`WITH candidate AS (
    SELECT id FROM aval_benchmark.agent_tasks
    WHERE organization_id = ${session.identity.organizationId}
      AND status IN ('queued', 'running') AND next_run_at <= now()
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    ORDER BY next_run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE aval_benchmark.agent_tasks AS task
    SET status = 'running', lease_owner = ${session.identity.requestId},
      lease_expires_at = now() + interval '60 seconds', lease_generation = task.lease_generation + 1
    FROM candidate WHERE task.id = candidate.id
    RETURNING task.id, task.organization_id, task.lease_generation::text, task.lease_owner`);
  return result.rows[0] ?? null;
}

export async function checkpoint(session: DbSession, task: { id: string; generation: string; owner: string }) {
  const result = await session.db.execute(sql`UPDATE aval_benchmark.agent_tasks
    SET step_count = step_count + 1
    WHERE id = ${task.id} AND organization_id = ${session.identity.organizationId}
      AND lease_generation = ${task.generation}::bigint AND lease_owner = ${task.owner}
      AND lease_expires_at > now() AND status = 'running' RETURNING id`);
  return result.rows.length === 1;
}

async function digest(input: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))), (b) => b.toString(16).padStart(2,"0")).join("");
}

export async function auditedWrite(session: DbSession, failAfterMutation = false) {
  // Lock a stable parent even when the audit log is empty. No advisory locks.
  const head = await session.db.execute(sql`SELECT audit_sequence::text, audit_hash
    FROM aval_benchmark.organizations WHERE id = ${session.identity.organizationId} FOR UPDATE`);
  if (!head.rows.length) throw new Error("Organization access denied");
  const existing = await session.db.execute(sql`SELECT sequence::text, entry_hash FROM aval_benchmark.answer_audit_log
    WHERE organization_id = ${session.identity.organizationId} AND request_id = ${session.identity.requestId}`);
  if (existing.rows.length) return { ...existing.rows[0], duplicate: true };
  const id = `${session.identity.organizationId}_property_00001`;
  const mutation = await session.db.execute(sql`UPDATE aval_benchmark.properties SET revision = revision + 1, updated_at = now()
    WHERE organization_id = ${session.identity.organizationId} AND id = ${id} RETURNING revision::text`);
  if (mutation.rows.length !== 1) throw new Error("Missing fixture property");
  if (failAfterMutation) throw new Error("Injected audit failure");
  const sequence = (BigInt(String(head.rows[0].audit_sequence)) + BigInt(1)).toString();
  const previousHash = String(head.rows[0].audit_hash);
  const payloadDigest = await digest(JSON.stringify({ id, revision: mutation.rows[0].revision }));
  // Spike-only protocol. Production's existing U+001F hash format must be preserved in Phase 2.
  const entryHash = await digest([sequence, previousHash, payloadDigest, session.identity.requestId].join("\u001f"));
  await session.db.execute(sql`INSERT INTO aval_benchmark.answer_audit_log
    (id, organization_id, sequence, previous_hash, entry_hash, payload_digest, request_id)
    VALUES (${crypto.randomUUID()}, ${session.identity.organizationId}, ${sequence}::bigint,
      ${previousHash}, ${entryHash}, ${payloadDigest}, ${session.identity.requestId})`);
  await session.db.execute(sql`UPDATE aval_benchmark.organizations SET audit_sequence = ${sequence}::bigint, audit_hash = ${entryHash}
    WHERE id = ${session.identity.organizationId}`);
  return { sequence, entry_hash: entryHash, duplicate: false };
}
