import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { AVAL_ONE, AVAL_ONE_ID, LEADS, SPECIALISTS, builtInActor, leadRuntimeId, specialistsForDomain } from "@/lib/agents/organization";

/**
 * The built-in organization, for the agent library.
 *
 * Customer-facing facts only: what each Lead and Specialist does, when Aval
 * uses it, what it needs, what it can and cannot do, and what needs approval.
 * Internal maturity, execution models and prompt text are deliberately absent
 * (directive §29): they describe how Aval is built, not what a customer can
 * rely on.
 *
 * The specialist catalogue is the heavy part, so it is sent only when asked
 * for (`?include=specialists`) — the library shows Leads first and the
 * expertise library on demand.
 */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const nameOf = (id: string) => builtInActor(id)?.name ?? id;
  const leads = LEADS.map((lead) => ({
    id: leadRuntimeId(lead),
    alias: lead.id,
    domain: lead.domain,
    name: lead.name,
    summary: lead.summary,
    historical: Boolean(lead.legacyPersonaId),
    specialistCount: specialistsForDomain(lead.domain).length,
    relatedLeads: lead.relatedDomains.map((domain) => leadRuntimeId(LEADS.find((row) => row.domain === domain)!)),
  }));
  const include = new URL(request.url).searchParams.get("include");
  const specialists = include === "specialists" ? SPECIALISTS.map((specialist) => ({
    id: specialist.id,
    name: specialist.name,
    domain: specialist.domain,
    boundary: specialist.boundary,
    notThis: { id: specialist.notThis.specialist, name: nameOf(specialist.notThis.specialist), because: specialist.notThis.because },
    triggers: specialist.triggers,
    inputs: specialist.inputs,
    outputs: specialist.outputs,
    capabilities: specialist.capabilities,
    approvals: specialist.approvals,
    forbidden: [...specialist.forbidden, ...(LEADS.find((lead) => lead.domain === specialist.domain)?.domainForbidden ?? [])],
    completion: specialist.completion,
    collaborators: specialist.collaborators.map((id) => ({ id, name: nameOf(id) })),
  })) : undefined;

  return Response.json({
    avalOne: { id: AVAL_ONE_ID, alias: AVAL_ONE.id, name: AVAL_ONE.name, subtitle: AVAL_ONE.subtitle, summary: AVAL_ONE.summary },
    leads,
    counts: { leads: LEADS.length, specialists: SPECIALISTS.length, domains: LEADS.length },
    ...(specialists ? { specialists } : {}),
  }, { headers: { "cache-control": "private, max-age=300" } });
}

export const GET = withApiSession(GETWithSession);
