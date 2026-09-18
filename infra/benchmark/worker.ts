import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { withDbSession } from "../../db/postgres/session.ts";
import type { DbIdentity } from "../../db/postgres/session.ts";
import { listProperties, claimTask, auditedWrite } from "./operations.ts";

export interface BenchmarkEnv {
  HYPERDRIVE?: { connectionString: string };
  BENCHMARK_TOKEN: string;
  // Local Node adapter only. Never generated as a deployed Wrangler variable.
  LOCAL_DATABASE_URL?: string;
  BENCHMARK_SOURCE_HASH: string;
  BENCHMARK_PROJECT_REF: string;
}

function authenticated(request: Request, secret: string) {
  if (!secret || secret.length < 32) return false;
  const supplied = Buffer.from(request.headers.get("Authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export default {
  async fetch(request: Request, env: BenchmarkEnv): Promise<Response> {
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
    if (!authenticated(request, env.BENCHMARK_TOKEN)) return json({ error: "Unauthorized" }, 401);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const url = new URL(request.url);
    const fixture = url.searchParams.get("tenant") ?? "0";
    const requestId = request.headers.get("Idempotency-Key");
    if (!/^[0-9]$/.test(fixture) || !requestId || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)) return json({ error: "Invalid fixture request" }, 400);
    if (!["/list", "/write", "/claim", "/inspect"].includes(url.pathname)) return json({ error: "Not found" }, 404);
    const identity: DbIdentity = {
      organizationId: `bench_org_${fixture}`, principalId: `principal_bench_org_${fixture}`,
      actorId: `principal_bench_org_${fixture}`, requestId,
    };
    const connectionString = env.HYPERDRIVE?.connectionString ?? env.LOCAL_DATABASE_URL;
    if (!connectionString) return json({ error: "Benchmark not configured" }, 503);
    const started = performance.now();
    try {
      const result = await withDbSession({ connectionString }, identity, async (session) => {
        if (url.pathname === "/list") return { properties: await listProperties(session) };
        if (url.pathname === "/claim") return { task: await claimTask(session) };
        if (url.pathname === "/write") return { audit: await auditedWrite(session) };
        const visible = await session.db.execute(sql`SELECT DISTINCT organization_id FROM aval_benchmark.properties`);
        const ownRequest = await session.db.execute(sql`SELECT sequence::text FROM aval_benchmark.answer_audit_log WHERE request_id = ${requestId}`);
        const role = await session.db.execute(sql`SELECT current_user AS role, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`);
        return { organizations: visible.rows.map((r) => r.organization_id), auditFound: ownRequest.rows.length === 1, role: role.rows[0] };
      }, { role: "aval_benchmark_app", readOnly: ["/list", "/inspect"].includes(url.pathname), verifyCleanContext: true });
      return json({ ok: true, result, elapsedMs: performance.now() - started, sourceHash: env.BENCHMARK_SOURCE_HASH,
        projectRef: env.BENCHMARK_PROJECT_REF,
        path: env.HYPERDRIVE ? "worker-hyperdrive" : "local-postgres",
        ingressColo: (request as Request & { cf?: { colo?: string } }).cf?.colo ?? null });
    } catch (error) {
      // Do not return/log SQL, credentials, row values or raw provider errors.
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "BENCHMARK_FAILED";
      return json({ error: "Benchmark operation failed", code }, 500);
    }
  },
};
