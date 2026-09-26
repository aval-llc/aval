import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { env } from "cloudflare:workers";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { streamAsk, type AskProgress } from "@/lib/ask-aval/progress";
import { handleAskAval } from "@/lib/ask-aval/handler";
import type { AskAvalEnv } from "@/lib/ask-aval/model-types";
import { openWork } from "@/lib/agents/open-work";
import { orchestrationDecision } from "@/lib/agents/organization/orchestration";
import { isOrchestrator } from "@/lib/agents/organization";
import { getOperatingProfile } from "@/lib/organizations/operating-profile-store";

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const body = await request.json().catch(() => ({})) as { question?: string; locale?: string; moduleLabel?: string; moduleSnapshot?: string; personaId?: string; chatMessageId?: string; view?: string };
  const question = typeof body.question === "string" ? body.question.slice(0, 600) : "";
  const locale = body.locale === "es-mx" ? "es-mx" : "en";
  const focusedModule = body.moduleLabel ? { label: body.moduleLabel, snapshot: body.moduleSnapshot ?? "" } : undefined;

  // Asked of Aval One, and the question needs specialist work: it becomes
  // durable Work on the same path every other Work takes — Aval One → Lead →
  // Specialist — attached to the saved chat turn, and the chat follows the run.
  // A question that is only a read is answered here, directly, as before. A
  // person who addressed a specific agent is answered by that agent.
  if (!isGuestIdentity(identity) && typeof body.chatMessageId === "string" && (!body.personaId || isOrchestrator(body.personaId))) {
    const decision = orchestrationDecision(question, await getOperatingProfile(dbSession, identity.organizationId));
    if (decision.delegate) {
      const opened = await openWork(dbSession, identity, env, {
        goal: question, agentId: "general", chatMessageId: body.chatMessageId, origin: "ask_aval",
        context: { view: body.view, moduleLabel: body.moduleLabel, moduleSnapshot: body.moduleSnapshot },
      });
      if (opened.ok) {
        return Response.json({
          work: { taskId: opened.taskId, taskAgentId: opened.agentId, reason: decision.reason, leads: decision.routing.leads.slice(0, 3).map((lead) => lead.name) },
        }, { status: 202, headers: { "x-aval-work": opened.taskId, "cache-control": "no-store" } });
      }
      // Could not attach to the saved turn (a stale or unsaved client): answer
      // directly rather than fail the person's question.
    }
  }

  const run = (onProgress?: (progress: AskProgress) => void) => handleAskAval(dbSession, question, env as unknown as AskAvalEnv, { orgId: identity.organizationId, userId: identity.userId }, locale, focusedModule, body.personaId, isGuestIdentity(identity), onProgress);
  return request.headers.get("accept")?.includes("application/x-ndjson") ? streamAsk(run) : run();
}

export const POST = withApiSession(POSTWithSession);
