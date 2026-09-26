/**
 * What a planner is told about whom it may assign work to.
 *
 * A plan names actors by id, so a planner that is not told the ids either
 * keeps every task for itself or invents names the delegation check will
 * refuse. Only the actors it may actually reach are listed: those it may
 * delegate to, inside the domains the workspace's business makes eligible —
 * with the candidates the router ranks for this objective first.
 */

import { builtInActor, eligibleDomains, LEADS, leadRuntimeId, specialistsForDomain } from "./index.ts";
import { routeObjective } from "./routing.ts";
import { EMPTY_PROFILE, type OperatingProfile } from "../../organizations/operating-profile.ts";

export function assignableActorsPrompt(agentId: string, context: { profile?: OperatingProfile; objective?: string } = {}): string {
  const actor = builtInActor(agentId);
  if (!actor || actor.delegatesTo.size === 0) return "";
  const profile = context.profile ?? EMPTY_PROFILE;
  const eligible = eligibleDomains(profile);
  const reachable = (id: string) => { const domain = builtInActor(id)?.domain; return !domain || eligible.has(domain); };
  const routed = context.objective ? routeObjective(context.objective, profile) : null;
  const candidates = routed && routed.specialists.length
    ? `\nMost likely for this objective (from the workspace's own routing, not a requirement): ${[
        ...routed.leads.slice(0, 3).map((lead) => `${lead.name} = ${lead.id}`),
        ...routed.specialists.filter((specialist) => actor.delegatesTo.has(specialist.id)).slice(0, 4).map((specialist) => `${specialist.name} = ${specialist.id}`),
      ].join("; ")}.${routed.singleDomain ? " One domain carries this, so assigning its Specialist directly is appropriate." : ""}`
    : "";
  if (actor.kind === "aval_one") {
    // Grouped by domain so the specialists stay one line per domain. A Lead is
    // not a mandatory hop: assign a specialist directly when the work is one
    // specialist's job.
    const domains = LEADS.filter((lead) => eligible.has(lead.domain)).map((lead) => {
      const team = specialistsForDomain(lead.domain).map((specialist) => specialist.id.split(".")[1]).join(", ");
      return `${lead.name} = ${leadRuntimeId(lead)}; specialists ${lead.domain}.{${team}}`;
    }).join("\n");
    return `\nYou may assign a task to a Lead, which can plan for its own team, or directly to a Specialist when the work is exactly one specialist's job. Only these domains apply to this workspace's business. Use agentId exactly as written here:\n${domains}${candidates}`;
  }
  const names = [...actor.delegatesTo].filter(reachable).map((id) => `${id} (${builtInActor(id)?.name ?? id})`).join(", ");
  return `\nYou may assign tasks to: ${names}. Use agentId exactly as written.${candidates}`;
}
