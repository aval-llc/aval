import type { DbSession } from "@/db/postgres/session";
/**
 * Named agent personas layered on top of the existing Ask Aval tool loop
 * (loop.ts) — a config table, not a new agent framework. A GitHub sourcing
 * pass (docs/DECISIONS.md) found no TS-native agent framework (Vercel AI
 * SDK, Mastra, LangChain.js, Cloudflare's own Durable-Object-based agents
 * SDK) that knows about this app's faithfulness gate or usage metering;
 * adopting one would mean reimplementing those safety checks inside
 * someone else's abstraction for what that same research found is, in
 * every real system examined, just a `{id, systemPromptAddition,
 * toolSubset}` registry. Every persona still runs through the same
 * runAskAvalLoop, faithfulness gate, and usage caps as the default
 * assistant — only the system-prompt framing and the tool subset change.
 *
 * `PersonaId` is intentionally duplicated (not imported) in
 * app/components/agent-avatar/personas.ts, a client component module —
 * keeping the ids in sync by convention avoids pulling any server-only
 * Ask Aval code into the client bundle for a handful of string literals.
 */

import type { ToolSchema } from "./model-types";

import { PERSONAS, type PersonaId, type AgentPersona } from "./persona-catalog.ts";
export { PERSONAS, type PersonaId, type AgentPersona } from "./persona-catalog.ts";

export function getPersona(id: string | undefined): AgentPersona {
  return (id && PERSONAS[id as PersonaId]) || PERSONAS.general;
}

/**
 * Resolves a personaId to an AgentPersona, checking the fixed built-in
 * roster first (no DB round-trip), then the organization's Leads and
 * Specialists, then the workspace's own employees scoped to `organizationId` —
 * an employee from a different org is invisible here, same as any other
 * org-scoped row in this app. Falls back to `general` if neither matches,
 * same as getPersona().
 */
export async function resolvePersona(dbSession: DbSession, id: string | undefined, organizationId: string): Promise<AgentPersona> {
  if (!id) return PERSONAS.general;
  const builtIn = PERSONAS[id as PersonaId];
  if (builtIn) return builtIn;
  // A Lead or Specialist of the organization, or an alias of a historical id
  // (`aval-one`, `lead.finance`). Historical ids answered above keep their
  // persona exactly; everything else is framed by its own definition.
  const { builtInActor } = await import("@/lib/agents/organization/index.ts");
  const actor = builtInActor(id);
  if (actor) {
    const legacy = PERSONAS[actor.id as PersonaId];
    if (legacy) return legacy;
    return { id: actor.id, label: actor.name, systemPromptAddition: actor.instructions, toolNames: actor.toolNames ? [...actor.toolNames] : null };
  }
  // One of the workspace's own employees — including every former custom
  // persona, which became an employee under the same id. Framed by the
  // employee's own instructions; its authority is its grant, applied by policy.
  const { getEmployee, employeeScopes } = await import("@/lib/agents/employees");
  const employee = await getEmployee(dbSession, organizationId, id);
  if (employee && employee.status !== "archived") {
    const scopes = await employeeScopes(dbSession, organizationId, employee.id);
    return {
      id: employee.id,
      label: employee.name,
      systemPromptAddition: `\n\nYou are currently acting as ${employee.name}, an employee this workspace created (${employee.role}). Its own framing, not a new hard rule — every rule above still applies exactly as written: ${employee.instructions ?? employee.objective ?? ""}`,
      toolNames: scopes.capability ?? [],
    };
  }
  return PERSONAS.general;
}

/** Filters `baseTools` (TOOLS or DRAFT_TOOLS) to a persona's subset, always keeping `record_preference` (standing corrections apply regardless of persona) and `finalToolName` (the model must always be able to conclude). */
export function personaTools(baseTools: ToolSchema[], persona: AgentPersona, finalToolName: string): ToolSchema[] {
  if (!persona.toolNames) return baseTools;
  const allowed = new Set([...persona.toolNames, "plan_goal", "get_goal_plan", "request_peer_help", "wait_for", "read_memory", "write_memory", "read_task_history", "read_conversation", "read_maintenance_context", "create_maintenance_work_order", "record_preference", "get_communication_channels", "list_conversations", "request_execution_plan", "send_external_message", "place_call", "get_marketing_channels", "publish_listing", finalToolName]);
  return baseTools.filter((tool) => allowed.has(tool.name));
}
