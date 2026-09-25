/**
 * One AI employee: what it is, what it may reach, and where it is in its life.
 *
 * Lifecycle is a POST with an action rather than a status field a client sets,
 * because the transitions are rules — archiving is refused while the employee
 * still owns unfinished work — and a client that could write `status` directly
 * would be able to route around them.
 */

import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { appendAuditEvents } from "@/lib/audit/log";
import { digestPayload, type AuditEntryKind } from "@/lib/audit/chain";
import {
  getEmployee, updateEmployee, setEmployeeStatus, employeeScopes, grantScope, revokeScope,
  openWorkCount, reassignWork,
  EmployeeHasOpenWorkError, InvalidEmployeeInputError,
  type EmployeeScope, type EmployeePatch, type EmployeeStatus,
} from "@/lib/agents/employees";
import { and,eq } from "drizzle-orm";
import { employeeExpertise, integrationConnections } from "@/db/postgres/schema";
import { getTool } from "@/lib/agents/registry";
import { grantExpertise, listExpertiseCatalogue, employeeCandidates } from "@/lib/agents/expertise";

const ACTION_STATUS: Record<string, EmployeeStatus> = {
  activate: "active", pause: "paused", resume: "active", archive: "archived",
};
const ACTION_AUDIT: Record<EmployeeStatus, AuditEntryKind> = {
  active: "employee_activated", paused: "employee_paused",
  archived: "employee_archived", draft: "employee_updated",
};

const employeeId = (request: Request): string =>
  decodeURIComponent(new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "");

/** GET: identity, scope, expertise and how much work this employee is carrying. */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const id = employeeId(request);
  const employee = await getEmployee(dbSession, identity.organizationId, id);
  if (!employee) return Response.json({ error: "No such employee" }, { status: 404 });

  return Response.json({
    employee,
    scopes: await employeeScopes(dbSession, identity.organizationId, id),
    expertise: await employeeCandidates(dbSession, identity.organizationId, id),
    openWork: await openWorkCount(dbSession, identity.organizationId, id),
  });
}

/** PATCH: edits identity and policy. Scope changes go through POST, being grants. */
async function PATCHWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  if(identity.role!=="owner")return Response.json({error:"Only workspace owners can configure employee access and policy."},{status:403});
  const id = employeeId(request);
  const body = await request.json().catch(() => ({})) as EmployeePatch;
  try {
    const employee = await updateEmployee(dbSession, identity.organizationId, id, body);
    if (!employee) return Response.json({ error: "No such employee" }, { status: 404 });
    await appendAuditEvents(dbSession, identity.organizationId, [{
      kind: "employee_updated", label: employee.role,
      payloadDigest: await digestPayload({ id, changed: Object.keys(body) }), count: 0,
    }]);
    return Response.json({ employee });
  } catch (error) {
    if (error instanceof InvalidEmployeeInputError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: "That name is already in use in this workspace." }, { status: 409 });
  }
}

/** POST { action }: lifecycle, scope grants, and reassignment. */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  if(identity.role!=="owner")return Response.json({error:"Only workspace owners can configure employee access and policy."},{status:403});
  const id = employeeId(request);
  const body = await request.json().catch(() => ({})) as {
    action?: string; expertiseId?: string; scope?: EmployeeScope; toEmployeeId?: string;
  };
  const employee = await getEmployee(dbSession, identity.organizationId, id);
  if (!employee) return Response.json({ error: "No such employee" }, { status: 404 });

  try {
    if((body.action==='grant_expertise'||body.action==='revoke_expertise')&&body.expertiseId){
      const catalogue=await listExpertiseCatalogue(dbSession,identity.organizationId);
      if(!catalogue.some(e=>e.id===body.expertiseId))return Response.json({error:'No such expertise in this workspace.'},{status:404});
      if(body.action==='grant_expertise')await grantExpertise(dbSession,identity.organizationId,id,body.expertiseId,identity.userId);
      else await dbSession.db.delete(employeeExpertise).where(and(eq(employeeExpertise.organizationId,identity.organizationId),eq(employeeExpertise.employeeId,id),eq(employeeExpertise.expertiseId,body.expertiseId)));
      await appendAuditEvents(dbSession,identity.organizationId,[{kind:'employee_updated',label:body.action,payloadDigest:await digestPayload({id,expertiseId:body.expertiseId}),count:0}]);
      return Response.json({expertise:await employeeCandidates(dbSession,identity.organizationId,id)});
    }
    if(body.action==='grant'&&body.scope?.kind==='connection'){
      const [connection]=await dbSession.db.select({id:integrationConnections.id}).from(integrationConnections).where(and(eq(integrationConnections.organizationId,identity.organizationId),eq(integrationConnections.id,body.scope.value))).limit(1);
      if(!connection)return Response.json({error:'No such connection in this workspace.'},{status:404});
    }
    if(body.action==='grant'&&body.scope?.kind==='capability'&&(!getTool(body.scope.value)||getTool(body.scope.value)?.unimplemented))return Response.json({error:'This capability is not implemented.'},{status:400});
    if (body.action === "grant" && body.scope) {
      await grantScope(dbSession, identity.organizationId, id, identity.userId, body.scope);
      await appendAuditEvents(dbSession, identity.organizationId, [{
        kind: "employee_scope_granted", label: body.scope.kind,
        payloadDigest: await digestPayload({ id, scope: body.scope }), count: 0,
      }]);
      return Response.json({ scopes: await employeeScopes(dbSession, identity.organizationId, id) });
    }

    if (body.action === "revoke" && body.scope) {
      await revokeScope(dbSession, identity.organizationId, id, body.scope);
      await appendAuditEvents(dbSession, identity.organizationId, [{
        kind: "employee_scope_revoked", label: body.scope.kind,
        payloadDigest: await digestPayload({ id, scope: body.scope }), count: 0,
      }]);
      return Response.json({ scopes: await employeeScopes(dbSession, identity.organizationId, id) });
    }

    if (body.action === "reassign" && body.toEmployeeId) {
      const moved = await reassignWork(dbSession, identity.organizationId, id, body.toEmployeeId);
      await appendAuditEvents(dbSession, identity.organizationId, [{
        kind: "employee_assigned_to_work", label: body.toEmployeeId,
        payloadDigest: await digestPayload({ from: id, to: body.toEmployeeId }), count: moved,
      }]);
      return Response.json({ reassigned: moved });
    }

    const status = ACTION_STATUS[body.action ?? ""];
    if (!status) return Response.json({ error: "Unknown action" }, { status: 400 });

    const updated = await setEmployeeStatus(dbSession, identity.organizationId, id, status);
    await appendAuditEvents(dbSession, identity.organizationId, [{
      kind: ACTION_AUDIT[status], label: updated?.role ?? employee.role,
      payloadDigest: await digestPayload({ id, status }), count: 0,
    }]);
    return Response.json({ employee: updated });
  } catch (error) {
    if (error instanceof EmployeeHasOpenWorkError) {
      // Refused rather than silently orphaning the work. The client is told how
      // much is outstanding so it can offer to reassign it.
      return Response.json({ error: error.message, openWork: error.openWork }, { status: 409 });
    }
    if (error instanceof InvalidEmployeeInputError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

export const GET = withApiSession(GETWithSession);
export const PATCH = withApiSession(PATCHWithSession);
export const POST = withApiSession(POSTWithSession);
