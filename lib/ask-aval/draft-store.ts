import { and, eq, ne, inArray } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { draftDocuments } from "@/db/postgres/schema";

export const validDraftId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

type Owner = { organizationId: string; userId: string };
const scope = (owner: Owner, id: string) =>
  and(
    eq(draftDocuments.organizationId, owner.organizationId),
    eq(draftDocuments.id, id),
  );

// Reserve the browser's ID before generation. A unique attempt token prevents
// an older paused/retried request from overwriting the latest result.
export async function reserveDraft(dbSession: DbSession,
  owner: Owner,
  id: string,
  input: {
    title: string;
    instructions: string;
    format: string;
    documentType: string | null;
    moduleLabel: string | null;
  }
) {
  const db = dbSession.db,
    now = new Date(),
    token = `queued:${crypto.randomUUID()}`;
  await db
    .insert(draftDocuments)
    .values({
      id,
      ...owner,
      ...input,
      status: token,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const rows = await db
    .update(draftDocuments)
    .set({ ...input, status: token, updatedAt: now })
    .where(and(scope(owner, id), ne(draftDocuments.status, "deleted")))
    .returning({ id: draftDocuments.id });
  return rows.length ? token : null;
}

export async function finishDraft(dbSession: DbSession,
  owner: Owner,
  id: string,
  token: string,
  response: Response
) {
  const data = (await response.clone().json()) as Record<string, unknown>;
  const success = response.ok && typeof data.document === "string";
  await dbSession.db
    .update(draftDocuments)
    .set({
      status: success ? "done" : "error",
      headline:
        success && typeof data.headline === "string" ? data.headline : null,
      narrative:
        success && typeof data.narrative === "string" ? data.narrative : null,
      documentMarkdown: success ? (data.document as string) : null,
      metricsJson: success ? JSON.stringify(data.metrics ?? []) : "[]",
      chartJson: success && data.chart ? JSON.stringify(data.chart) : null,
      confidence:
        success && typeof data.confidence === "string" ? data.confidence : null,
      errorMessage: success
        ? null
        : typeof data.error === "string"
          ? data.error
          : "The draft could not be generated.",
      updatedAt: new Date(),
    })
    .where(and(scope(owner, id), eq(draftDocuments.status, token)));
}

export async function removeDrafts(dbSession: DbSession, owner: Owner, ids: string[]) {
  const db = dbSession.db,
    now = new Date();
  // Content-free tombstones also cover a delete that arrives before generation
  // is registered. Late model responses can never recreate a removed draft.
  // Small multi-row batches stay below D1's bound-parameter limit.
  for (let offset = 0; offset < ids.length; offset += 5) {
    await db
      .insert(draftDocuments)
      .values(
        ids.slice(offset, offset + 5).map((id) => ({
          id,
          ...owner,
          title: "",
          instructions: "",
          format: "docx",
          status: "deleted",
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing();
  }

  await db
    .update(draftDocuments)
    .set({
      status: "deleted",
      title: "",
      instructions: "",
      headline: null,
      narrative: null,
      documentType: null,
      documentMarkdown: null,
      metricsJson: "[]",
      chartJson: null,
      confidence: null,
      errorMessage: null,
      sentTo: null,
      moduleLabel: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(draftDocuments.organizationId, owner.organizationId),
        inArray(draftDocuments.id, ids),
      ),
    );
}
