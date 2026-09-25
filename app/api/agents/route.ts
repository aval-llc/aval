import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { createEmployee, DuplicateEmployeeNameError, EmployeeQuotaError, InvalidEmployeeInputError } from "@/lib/agents/employees";
import { validateCustomPersonaInput, InvalidPersonaInputError } from "@/lib/ask-aval/persona-validation";
import { getTool } from "@/lib/agents/registry";

/**
 * The custom-persona endpoint, kept as a compatibility adapter.
 *
 * Custom personas became AI Employees (migration 20260925000200): one concept,
 * "Your employees", not two. Every existing persona is an employee under its
 * own id, so the directory lists it through /api/agents/employees and this
 * endpoint no longer lists anything of its own — listing them here too would
 * show each twice.
 *
 * A client that still creates a persona here gets an employee, with the
 * persona's read-only ceiling: its tools become capability grants, reads only,
 * exactly what the persona envelope allowed.
 */

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  return Response.json({ personas: [], migratedTo: "/api/agents/employees" });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  if (identity.role !== "owner") return Response.json({ error: "Only workspace owners can create and configure employees." }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { label?: string; focusDescription?: string; toolNames?: string[]; shape?: string; theme?: string };
  try {
    const clean = validateCustomPersonaInput({
      label: typeof body.label === "string" ? body.label : "",
      focusDescription: typeof body.focusDescription === "string" ? body.focusDescription : "",
      toolNames: Array.isArray(body.toolNames) ? body.toolNames.filter((name) => typeof name === "string") : null,
      shape: typeof body.shape === "string" ? body.shape : "",
      theme: typeof body.theme === "string" ? body.theme : "",
    });
    const reads = (clean.toolNames ?? []).filter((name) => { const tool = getTool(name); return tool && !tool.mutates && !tool.unimplemented; });
    const employee = await createEmployee(dbSession, identity.organizationId, identity.userId, {
      name: clean.label, role: "Custom agent", objective: clean.focusDescription, instructions: clean.focusDescription,
      status: "active", autonomyMode: "supervised",
      scopes: reads.map((value) => ({ kind: "capability" as const, value })),
    });
    return Response.json({
      persona: { id: employee.id, label: employee.name, focusDescription: clean.focusDescription, toolNames: reads },
      employee,
      migratedTo: "/api/agents/employees",
    }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPersonaInputError || err instanceof InvalidEmployeeInputError) return Response.json({ error: err.message }, { status: 400 });
    if (err instanceof DuplicateEmployeeNameError || err instanceof EmployeeQuotaError) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
