import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { env } from "cloudflare:workers";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { streamAsk, type AskProgress } from "@/lib/ask-aval/progress";
import { handleAskAval } from "@/lib/ask-aval/handler";
import type { AskAvalEnv } from "@/lib/ask-aval/model-types";

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const body = await request.json().catch(() => ({})) as { question?: string; locale?: string; moduleLabel?: string; moduleSnapshot?: string; personaId?: string };
  const question = typeof body.question === "string" ? body.question.slice(0, 600) : "";
  const locale = body.locale === "es-mx" ? "es-mx" : "en";
  const focusedModule = body.moduleLabel ? { label: body.moduleLabel, snapshot: body.moduleSnapshot ?? "" } : undefined;

  const run = (onProgress?: (progress: AskProgress) => void) => handleAskAval(dbSession, question, env as unknown as AskAvalEnv, { orgId: identity.organizationId, userId: identity.userId }, locale, focusedModule, body.personaId, isGuestIdentity(identity), onProgress);
  return request.headers.get("accept")?.includes("application/x-ndjson") ? streamAsk(run) : run();
}

export const POST = withApiSession(POSTWithSession);
