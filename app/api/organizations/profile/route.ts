import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { appendAuditEvents } from "@/lib/audit/log";
import { digestPayload } from "@/lib/audit/chain";
import { ASSET_CLASSES, BUSINESS_MODELS } from "@/lib/organizations/operating-profile";
import { getOperatingProfile, setOperatingProfile } from "@/lib/organizations/operating-profile-store";
import { eligibleDomains, LEADS, leadRuntimeId } from "@/lib/agents/organization";

/**
 * The workspace's operating profile, with the taxonomy it is chosen from and
 * the Leads it currently makes reachable.
 *
 * The taxonomy is sent with the profile so the settings UI renders whatever
 * the registry holds rather than a list of its own.
 */
async function describe(dbSession: DbSession, organizationId: string) {
  const profile = await getOperatingProfile(dbSession, organizationId);
  const eligible = eligibleDomains(profile);
  return {
    profile,
    taxonomy: { businessModels: BUSINESS_MODELS, assetClasses: ASSET_CLASSES },
    reachableLeads: LEADS.filter((lead) => eligible.has(lead.domain)).map((lead) => ({ id: leadRuntimeId(lead), name: lead.name, domain: lead.domain })),
  };
}

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  return Response.json(await describe(dbSession, identity.organizationId), { headers: { "cache-control": "no-store" } });
}

async function PUTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  // Which Leads the workspace's work may reach is a workspace decision.
  if (identity.role !== "owner") return Response.json({ error: "Only workspace owners can change the business profile." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const profile = await setOperatingProfile(dbSession, identity.organizationId, body);
  await appendAuditEvents(dbSession, identity.organizationId, [{
    kind: "operating_profile_changed", label: `v${profile.version}`, payloadDigest: await digestPayload(profile), count: profile.businessModels.length + profile.assetClasses.length,
  }]);
  return Response.json(await describe(dbSession, identity.organizationId));
}

export const GET = withApiSession(GETWithSession);
export const PUT = withApiSession(PUTWithSession);
