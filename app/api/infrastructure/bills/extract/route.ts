import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { env } from "cloudflare:workers";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { handleUtilityBillExtraction } from "@/lib/infrastructure/bill-extraction";
import type { AskAvalEnv } from "@/lib/ask-aval/model-types";

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const body = (await request.json().catch(() => ({}))) as { billText?: string };
  const billText = typeof body.billText === "string" ? body.billText : "";

  return handleUtilityBillExtraction(dbSession, billText, env as unknown as AskAvalEnv, { orgId: identity.organizationId, userId: identity.userId });
}

export const POST = withApiSession(POSTWithSession);
