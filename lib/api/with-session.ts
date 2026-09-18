import type { Client } from "pg";
import { headers } from "next/headers";
import { withDbSession, type DbIdentity, type DbSession } from "@/db/postgres/session";
import { activeOrganizationFromRequest } from "@/lib/auth/supabase";
import { verifiedIdentityFromRequest } from "@/lib/auth/request-identity";
import { organizationIdForUser } from "@/lib/integrations/session";
import { postgresClientConfig, runtimeBindings, type AvalRuntimeBindings } from "@/lib/runtime/bindings";

export type SessionRouteHandler<Context = unknown> = (
  session: DbSession,
  request: Request,
  context: Context,
) => Promise<Response> | Response;

async function initializeSupabaseIdentity(
  client: Client,
  baseIdentity: DbIdentity,
  requestedOrganization: string | undefined,
): Promise<DbIdentity> {
  const auth = baseIdentity.auth;
  if (!auth || auth.source !== "password") throw new Error("Supabase identity is required");
  const result = await client.query<{ organization_id: string }>(
    `SELECT aval_private.bootstrap_supabase_identity($1, $2, $3, $4, $5, $6) AS organization_id`,
    [auth.userId, auth.email, auth.displayName, true, baseIdentity.organizationId, requestedOrganization ?? null],
  );
  const organizationId = result.rows[0]?.organization_id;
  if (!organizationId) throw new Error("Supabase identity bootstrap did not resolve an organization");
  return Object.freeze({ ...baseIdentity, organizationId });
}

export function withApiSession<Context = unknown>(handler: SessionRouteHandler<Context>) {
  return async function authenticatedRoute(request: Request, context: Context): Promise<Response> {
    const response = await withRequestSession<Response>(request, (session) => Promise.resolve(handler(session, request, context)));
    return response ?? Response.json({ error: "Authentication required" }, { status: 401, headers: { "cache-control": "no-store" } });
  };
}

export async function withRequestSession<T>(request: Request, work: (session: DbSession) => Promise<T>): Promise<T | null> {
  const verified = verifiedIdentityFromRequest(request);
  if (!verified) return null;
  const personalOrganization = await organizationIdForUser(verified.userId);
  const requestedOrganization = activeOrganizationFromRequest(request);
  const baseIdentity: DbIdentity = {
    principalId: verified.userId,
    organizationId: personalOrganization,
    actorId: verified.userId,
    requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
    auth: { userId: verified.userId, email: verified.email, displayName: verified.displayName, source: "password" },
  };
  return withDbSession(
    postgresClientConfig(runtimeBindings()),
    baseIdentity,
    work,
    { initializeIdentity: (client, identity) => initializeSupabaseIdentity(client, identity, requestedOrganization) },
  );
}

export async function withPageSession<T>(work: (session: DbSession) => Promise<T>): Promise<T | null> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "aval.invalid";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const request = new Request(`${protocol}://${host}/`, { headers: requestHeaders });
  return withRequestSession(request, work);
}

export async function withSystemSession<T>(
  kind: "auth" | "worker",
  work: (session: DbSession) => Promise<T>,
  bindings: AvalRuntimeBindings = runtimeBindings(),
): Promise<T> {
  const suffix = kind === "auth" ? "auth" : "worker";
  return withDbSession(postgresClientConfig(bindings), {
    principalId: `principal_aval_${suffix}`,
    organizationId: "org_system",
    actorId: `principal_aval_${suffix}`,
    requestId: crypto.randomUUID(),
  }, work, { role: kind === "worker" ? "aval_worker" : "aval_app" });
}

export async function withWorkerOrganizationSession<T>(
  organizationId: string,
  work: (session: DbSession) => Promise<T>,
  bindings: AvalRuntimeBindings = runtimeBindings(),
): Promise<T> {
  if (!organizationId || organizationId.length > 256 || organizationId.includes("\0")) throw new Error("Invalid worker organization");
  return withDbSession(postgresClientConfig(bindings), {
    principalId: "principal_aval_worker",
    organizationId,
    actorId: "principal_aval_worker",
    requestId: crypto.randomUUID(),
  }, work, { role: "aval_worker" });
}
