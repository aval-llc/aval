import { withApiSession } from "@/lib/api/with-session";
import { desc, eq, and, ne } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { draftDocuments } from "@/db/postgres/schema";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";

import { ensureOrganization } from "@/lib/integrations/organizations";
import { removeDrafts, validDraftId } from "@/lib/ask-aval/draft-store";

/** Every persisted Ask Aval Tasks draft for this org, newest first — hydrates the client on load so a refresh doesn't lose them. */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const db = dbSession.db;
  const rows = await db
    .select()
    .from(draftDocuments)
    .where(
      and(
        eq(draftDocuments.organizationId, identity.organizationId),
        ne(draftDocuments.status, "deleted"),
      ),
    )
    .orderBy(desc(draftDocuments.createdAt));

  return Response.json(
    {
      documents: rows.map((row) => ({
        id: row.id,
        title: row.title,
        instructions: row.instructions,
        format: row.format,
        status: row.status,
        headline: row.headline,
        narrative: row.narrative,
        documentType: row.documentType,
        document: row.documentMarkdown,
        metrics: JSON.parse(row.metricsJson || "[]"),
        chart: row.chartJson ? JSON.parse(row.chartJson) : null,
        confidence: row.confidence,
        error: row.errorMessage,
        sentTo: row.sentTo,
        moduleLabel: row.moduleLabel,
        createdAt: row.createdAt?.getTime() ?? Date.now(),
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function PATCHWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity)
    return Response.json({ error: "Authentication required" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    sentTo?: string;
  };
  if (!body.id || !body.sentTo)
    return Response.json(
      { error: "id and sentTo are required" },
      { status: 400 },
    );

  const db = dbSession.db;
  await db
    .update(draftDocuments)
    .set({ sentTo: body.sentTo, updatedAt: new Date() })
    .where(
      and(
        eq(draftDocuments.id, body.id),
        eq(draftDocuments.organizationId, identity.organizationId),
        ne(draftDocuments.status, "deleted"),
      ),
    );

  return Response.json({ ok: true });
}

/** Delete exactly the selected drafts, including a Clear snapshot. */
async function DELETEWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity || isGuestIdentity(identity))
    return Response.json(
      { error: "Sign in to manage drafts" },
      { status: 401 },
    );
  const body = (await request.json().catch(() => null)) as {
    ids?: unknown;
  } | null;
  if (
    !body ||
    !Array.isArray(body.ids) ||
    !body.ids.length ||
    body.ids.length > 50 ||
    !body.ids.every(validDraftId)
  ) {
    return Response.json(
      { error: "Provide 1–50 valid draft IDs" },
      { status: 400 },
    );
  }
  await ensureOrganization(dbSession, identity);
  await removeDrafts(dbSession, identity, [...new Set<string>(body.ids)]);
  return Response.json(
    { ok: true },
    { headers: { "cache-control": "no-store" } },
  );
}

export const GET = withApiSession(GETWithSession);
export const PATCH = withApiSession(PATCHWithSession);
export const DELETE = withApiSession(DELETEWithSession);
