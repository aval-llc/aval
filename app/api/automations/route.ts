import { withApiSession } from "@/lib/api/with-session";
import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { automationRuns, automationSteps } from "@/db/postgres/schema";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { buildOperationsOverview } from "@/lib/operations/summary";
import type { OperationsInsight } from "@/lib/operations/insights";
import { handleAskAvalDraft } from "@/lib/ask-aval/draft";
import type { AskAvalEnv } from "@/lib/ask-aval/model-types";

/** Automation proposals are derived only from the caller's current operations records. */
function automationForInsight(insight: OperationsInsight) {
  return {
    channel: "aval",
    reportedActor: insight.module,
    reportedSummary: `${insight.title}. ${insight.detail}`,
    acknowledgedSummary:
      "Reviewing the supporting workspace records before preparing a proposal.",
    draftTitle: insight.title,
    draftInstructions: `Prepare an internal proposal for human review. Do not claim that messages were sent, prices changed, or work completed. Verify facts with workspace tools and cite the available records. Finding: ${insight.title}. Detail: ${insight.detail}. Suggested action: ${insight.suggestedAction}. Evidence: ${JSON.stringify(insight.evidence)}.`,
  };
}

function withChannel(channel: string) {
  return JSON.stringify({ channel });
}

async function loadRunWithSteps(dbSession: DbSession, organizationId: string, insightId: string) {
  const db = dbSession.db;
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.organizationId, organizationId),
        eq(automationRuns.insightId, insightId),
      ),
    )
    .orderBy(desc(automationRuns.createdAt))
    .limit(1);
  if (!run) return { run: null, steps: [] };
  const steps = await db
    .select()
    .from(automationSteps)
    .where(eq(automationSteps.runId, run.id));
  return {
    run,
    steps: steps.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
  };
}

async function loadTriggers(dbSession: DbSession, organizationId: string) {
  const triggers = [];
  const { insights } = await buildOperationsOverview(dbSession, organizationId);
  for (const insight of insights) {
    const config = automationForInsight(insight);
    const { run, steps } = await loadRunWithSteps(dbSession, organizationId, insight.id);
    triggers.push({
      insightId: insight.id,
      title: insight.title,
      channel: config.channel,
      run,
      steps,
    });
  }
  return triggers;
}

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity)
    return Response.json({ error: "Authentication required" }, { status: 401 });
  const triggers = await loadTriggers(dbSession, identity.organizationId);
  return Response.json(
    { triggers },
    { headers: { "cache-control": "no-store" } },
  );
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity)
    return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  const db = dbSession.db;
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    runId?: string;
    insightId?: string;
  };

  if (body.action === "approve" && body.runId) {
    // Scoped by organizationId, not just id — an unscoped lookup here would let
    // any authenticated user approve (and thus mutate) another org's automation
    // run by guessing or observing its id, a cross-tenant write.
    const [run] = await db
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.id, body.runId),
          eq(automationRuns.organizationId, identity.organizationId),
        ),
      );
    if (!run)
      return Response.json(
        { error: "Automation run not found" },
        { status: 404 },
      );
    if (run.status !== "awaiting_approval")
      return Response.json(
        { error: "This proposal is not awaiting approval" },
        { status: 409 },
      );
    const now = new Date();
    await db.insert(automationSteps).values({
      id: crypto.randomUUID(),
      runId: run.id,
      kind: "resolved",
      actorLabel: identity.displayName,
      summary:
        "Proposal approved for manual follow-up. No outreach was sent or external records changed.",
      payloadJson: withChannel("aval"),
      createdAt: now,
    });
    await db
      .update(automationRuns)
      .set({ status: "resolved", updatedAt: now })
      .where(eq(automationRuns.id, run.id));
    return Response.json({
      triggers: await loadTriggers(dbSession, identity.organizationId),
    });
  }

  if (body.action === "start" && body.insightId) {
    const { insights } = await buildOperationsOverview(dbSession, identity.organizationId);
    const insight = insights.find(
      (candidate) => candidate.id === body.insightId,
    );
    if (!insight)
      return Response.json(
        { error: "Trigger insight not found" },
        { status: 404 },
      );

    const config = automationForInsight(insight);
    const now = new Date();
    const runId = crypto.randomUUID();
    await db
      .insert(automationRuns)
      .values({
        id: runId,
        organizationId: identity.organizationId,
        insightId: insight.id,
        status: "running",
        createdAt: now,
        updatedAt: now,
      });

    const addStep = (
      kind: string,
      actorLabel: string,
      summary: string,
      channel: string,
    ) =>
      db
        .insert(automationSteps)
        .values({
          id: crypto.randomUUID(),
          runId,
          kind,
          actorLabel,
          summary,
          payloadJson: withChannel(channel),
          createdAt: new Date(),
        });

    await addStep(
      "reported",
      config.reportedActor,
      config.reportedSummary,
      "aval",
    );
    await addStep("acknowledged", "Aval", config.acknowledgedSummary, "aval");

    const draftResponse = await handleAskAvalDraft(dbSession,
      {
        title: config.draftTitle,
        instructions: config.draftInstructions,
        format: "docx",
      },
      env as unknown as AskAvalEnv,
      { orgId: identity.organizationId, userId: identity.userId },
      "en",
      undefined,
      undefined,
      isGuestIdentity(identity),
    );
    const draftData = (await draftResponse.json().catch(() => ({}))) as {
      headline?: string;
      narrative?: string;
      error?: string;
    };

    if (!draftResponse.ok || !draftData.narrative) {
      await addStep(
        "failed",
        "Aval",
        draftData.error ?? "Could not draft this right now.",
        config.channel,
      );
      await db
        .update(automationRuns)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(automationRuns.id, runId));
      return Response.json(
        {
          error: "The proposal could not be prepared.",
          triggers: await loadTriggers(dbSession, identity.organizationId),
        },
        { status: 503 },
      );
    }
    await addStep("vendor_draft", "Aval", draftData.narrative, config.channel);
    await addStep(
      "awaiting_approval",
      "Aval",
      "Proposal ready for review. No external actions have been taken.",
      config.channel,
    );
    await db
      .update(automationRuns)
      .set({ status: "awaiting_approval", updatedAt: new Date() })
      .where(eq(automationRuns.id, runId));

    return Response.json({
      triggers: await loadTriggers(dbSession, identity.organizationId),
    });
  }

  return Response.json(
    { error: "Unrecognized automation action" },
    { status: 400 },
  );
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
