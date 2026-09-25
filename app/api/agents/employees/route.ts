/**
 * The AI employee directory.
 *
 * Data-driven by construction: there is no list of roles here, no fixed slot
 * count and nothing that knows about eight of anything. The response is rows,
 * paged, and a workspace with one employee and a workspace with a hundred and
 * one are served by the same query.
 */

import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { appendAuditEvents } from "@/lib/audit/log";
import {
  createEmployee, employeeCount, employeeLimit, listEmployees,
  DuplicateEmployeeNameError, EmployeeQuotaError, InvalidEmployeeInputError,
  type EmployeeStatus, type CreateEmployeeInput,
} from "@/lib/agents/employees";
import { STARTER_TEMPLATES, createEmployeeFromTemplate } from "@/lib/agents/expertise";
import { digestPayload } from "@/lib/audit/chain";

const PAGE_SIZE = 50;

/** GET: the workspace's employees, with the templates a new one can start from. */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") as EmployeeStatus | null;
  const employees = await listEmployees(dbSession, identity.organizationId, {
    status: status ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? PAGE_SIZE),
    offset: Number(url.searchParams.get("offset") ?? 0),
  });

  return Response.json({
    employees,
    total: await employeeCount(dbSession, identity.organizationId),
    // Null means no limit. The client shows a ceiling only where one exists,
    // rather than inventing one to render against.
    limit: await employeeLimit(dbSession, identity.organizationId),
    templates: STARTER_TEMPLATES,
  });
}

/**
 * POST: creates an employee.
 *
 * Creating one grants nothing. Scopes, expertise and external contact are
 * separate, deliberate acts, so an employee that exists and an employee that
 * can do something are two different states a person has to move between.
 */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  if(identity.role!=="owner")return Response.json({error:"Only workspace owners can create and configure employees."},{status:403});
  const body = await request.json().catch(() => ({})) as Partial<CreateEmployeeInput> & { templateSlug?: string };
  try {
    // From a template: the template's capabilities and expertise come with it,
    // not just its name and role. Chosen by a person, one employee at a time.
    const employee = typeof body.templateSlug === "string" && body.templateSlug
      ? await createEmployeeFromTemplate(dbSession, identity.organizationId, identity.userId, body.templateSlug, { name: typeof body.name === "string" ? body.name : undefined })
      : await createEmployee(dbSession, identity.organizationId, identity.userId, {
      name: String(body.name ?? ""),
      role: String(body.role ?? ""),
      description: body.description ?? null,
      objective: body.objective ?? null,
      instructions: body.instructions ?? null,
      autonomyMode: body.autonomyMode,
      approvalPolicy: body.approvalPolicy,
      spendLimitCents: body.spendLimitCents ?? null,
      riskCeiling: body.riskCeiling,
      memoryScope: body.memoryScope,
      mayCommunicateExternally: body.mayCommunicateExternally ?? false,
      mayDelegate: body.mayDelegate ?? false,
      scopes: body.scopes ?? [],
    });
    await appendAuditEvents(dbSession, identity.organizationId, [{
      kind: "employee_created", label: employee.role,
      payloadDigest: await digestPayload({ id: employee.id, role: employee.role }), count: 0,
    }]);
    return Response.json({ employee }, { status: 201 });
  } catch (error) {
    if (error instanceof EmployeeQuotaError) {
      return Response.json({ error: error.message, limit: error.limit }, { status: 409 });
    }
    if (error instanceof InvalidEmployeeInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DuplicateEmployeeNameError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
