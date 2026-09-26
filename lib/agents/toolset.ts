/**
 * One place that decides which tools a model is offered.
 *
 * There were two, and they did not agree. The durable runtime intersected the
 * persona's subset, the permission envelope and the PMS capability matrix. The
 * synchronous chat and draft paths applied the persona subset alone — and the
 * default persona declares no subset, so the model was handed every schema in
 * the registry, PMS writes included. A durable-task guard elsewhere meant those
 * writes could not actually execute, but that is a safety property resting on a
 * correctness mechanism, and it left the model responsible for not calling
 * tools it had no business calling.
 *
 * The directive is explicit that it must not be: what an employee may reach is
 * narrowed before the model sees it, so a forbidden tool is absent rather than
 * refused. A tool that does not exist cannot be reached by a prompt injection,
 * a confused plan, or a model having an off day.
 */

import type { DbSession } from "@/db/postgres/session";
import type { AgentPersona } from "@/lib/ask-aval/persona-catalog";
import type { ToolSchema } from "@/lib/ask-aval/model-types";
import { personaTools } from "@/lib/ask-aval/personas";
import { isPmsWriteTool } from "@/lib/pms/tool-map";
import { pmsToolAvailability } from "@/lib/pms/assembly";
import { allowedToolNames } from "./policy.ts";
import { effectiveEmployeeAccess } from "./employee-access";
import { getTool } from "./registry.ts";
import { deploymentActorId } from "./organization/index.ts";

export interface ToolsetRequest {
  employeeId?: string;
  organizationId: string;
  subject: { organizationId: string; userId: string; isGuest: boolean };
  /** Whose permission envelope applies. */
  agentId: string | undefined;
  persona: AgentPersona;
  /** The full schema list to narrow: TOOLS for a run, DRAFT_TOOLS for a draft. */
  baseTools: readonly ToolSchema[];
  /** The tool the model must always be able to finish with. */
  finalToolName: string;
  /**
   * Capabilities this employee was granted, when the work has an owner.
   *
   * Absent means "not employee-scoped" and changes nothing. An empty array
   * means an employee that was granted no capabilities, which narrows to
   * nothing — absence of a grant is never permission.
   */
  employeeCapabilities?: readonly string[] | null;
  /** Capabilities the loaded expertise needs. Narrows further, never widens. */
  expertiseCapabilities?: readonly string[] | null;
  /** The owning employee's authority, used in place of the persona envelope. */
  employeePermissions?: readonly import("./permissions.ts").Permission[] | null;
}

export interface AssembledToolset {
  tools: ToolSchema[];
  /** Why each excluded tool was excluded, for the audit trail and for operators. */
  excluded: Record<string, "permission" | "persona" | "provider" | "employee" | "expertise">;
}

/**
 * Tools that change only the task itself — its scratchpad, its wait, its
 * question to a peer — and never anything in the business. Expertise bounds
 * what a Specialist may change in the business, so it does not remove these;
 * the runtime's completion contract still decides which a run is offered.
 */
const TASK_SELF_TOOLS: ReadonlySet<string> = new Set(["wait_for", "request_peer_help", "write_memory"]);

/**
 * The tools this work may actually use.
 *
 * Every narrowing is an intersection and none of them can add anything, so the
 * result is bounded by the strictest. Order is for legibility only.
 */
export async function assembleToolset(
  dbSession: DbSession,
  request: ToolsetRequest,
): Promise<AssembledToolset> {
  const effective = request.employeeId ? await effectiveEmployeeAccess(dbSession,request.organizationId,request.employeeId) : null;
  const excluded: AssembledToolset["excluded"] = {};
  const keep = (name: string) => name === request.finalToolName;

  // 1. Persona framing: the subset this persona declares an interest in.
  const framed = new Set(
    personaTools([...request.baseTools], request.persona, request.finalToolName).map((tool) => tool.name),
  );

  // 2. Authority: the permission envelope. A persona listing a tool it has no
  //    permission for loses it here rather than being granted it.
  const permitted = new Set(allowedToolNames(request.agentId, request.subject, request.employeePermissions));

  // 3. Provider capability: which PMS writes this workspace can actually reach,
  //    for this agent's deployments. Fail-closed on error, inside that module.
  const pms = await pmsToolAvailability(dbSession, request.organizationId, deploymentActorId(request.agentId ?? ""));

  // 4. Employee scope, when the work has an owner.
  const employeeScoped = request.employeeCapabilities == null
    ? null
    : new Set(request.employeeCapabilities);

  // 5. Expertise requirements, when expertise was loaded.
  const expertiseScoped = request.expertiseCapabilities == null || request.expertiseCapabilities.length === 0
    ? null
    : new Set(request.expertiseCapabilities);

  const tools: ToolSchema[] = [];
  for (const tool of request.baseTools) {
    if (keep(tool.name)) { tools.push(tool); continue; }
    if(effective && !effective.capabilities.includes(tool.name)){excluded[tool.name]="employee";continue;}

    // A persona's declared subset is a curation of what it should be *reading*
    // — it is framing, not authority. Applying it to provider writes made those
    // writes unreachable for every persona: a declared subset never lists them,
    // and the one persona with no subset holds no write permission. A workspace
    // could connect a PMS, sign the authorization, and never be offered the
    // tool. Writes are governed by the permission envelope and the capability
    // matrix below, which is where that decision actually belongs.
    const providerWrite = isPmsWriteTool(tool.name);
    if (!providerWrite && !framed.has(tool.name)) { excluded[tool.name] = "persona"; continue; }
    if (!permitted.has(tool.name)) { excluded[tool.name] = "permission"; continue; }
    if (providerWrite && !pms.toolNames.has(tool.name)) { excluded[tool.name] = "provider"; continue; }
    if (employeeScoped && !employeeScoped.has(tool.name)) { excluded[tool.name] = "employee"; continue; }
    if (expertiseScoped && !expertiseScoped.has(tool.name) && getTool(tool.name)?.mutates && !TASK_SELF_TOOLS.has(tool.name)) {
      // Expertise narrows what may be *changed*, not what may be read: an
      // employee briefed on maintenance still needs to look things up.
      excluded[tool.name] = "expertise";
      continue;
    }
    tools.push(tool);
  }
  return { tools, excluded };
}
