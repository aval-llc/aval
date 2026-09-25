/**
 * What a planner is told about whom it may assign work to.
 *
 * A plan names actors by id, so a planner that is not told the ids either
 * keeps every task for itself or invents names the delegation check will
 * refuse. Only the actors it may actually reach are listed.
 */

import { builtInActor, LEADS, leadRuntimeId, specialistsForDomain } from "./index.ts";

export function assignableActorsPrompt(agentId: string): string {
  const actor = builtInActor(agentId);
  if (!actor || actor.delegatesTo.size === 0) return "";
  if (actor.kind === "aval_one") {
    // Grouped by domain so 266 specialists stay one line each domain. A Lead
    // is not a mandatory hop: assign a specialist directly when the work is
    // one specialist's job.
    const domains = LEADS.map((lead) => {
      const team = specialistsForDomain(lead.domain).map((specialist) => specialist.id.split(".")[1]).join(", ");
      return `${lead.name} = ${leadRuntimeId(lead)}; specialists ${lead.domain}.{${team}}`;
    }).join("\n");
    return `\nYou may assign a task to a Lead, which can plan for its own team, or directly to a Specialist when the work is exactly one specialist's job. Use agentId exactly as written here:\n${domains}`;
  }
  const names = [...actor.delegatesTo].map((id) => `${id} (${builtInActor(id)?.name ?? id})`).join(", ");
  return `\nYou may assign tasks to: ${names}. Use agentId exactly as written.`;
}
