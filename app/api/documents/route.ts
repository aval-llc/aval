import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { deleteDocument, listDocuments, saveDocument } from "@/lib/documents/store";
import { isDocumentKind, MAX_DOCUMENT_CHARS } from "@/lib/documents/types";

/** GET /api/documents — this workspace's documents, metadata only (no bodies). */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  return Response.json({ documents: await listDocuments(dbSession, identity.organizationId) });
}

/**
 * POST /api/documents — stores a document's text.
 *
 * Over-long text is truncated rather than rejected, and the response says so,
 * so the client can state it plainly instead of leaving the user with a
 * document that is quietly missing its tail.
 */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const body = (await request.json().catch(() => ({}))) as { title?: string; kind?: string; contentText?: string; requestId?: string };
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid document request." }, { status: 400 });
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId))) return Response.json({ error: "Invalid upload request." }, { status: 400 });
  if (body.requestId && isGuestIdentity(identity)) return Response.json({ error: "Sign in to upload files." }, { status: 401 });
  const contentText = typeof body.contentText === "string" ? body.contentText : "";
  if (!contentText.trim()) return Response.json({ error: "Document text is required" }, { status: 400 });
  const kind = typeof body.kind === "string" && isDocumentKind(body.kind) ? body.kind : "other";

  const saved = await saveDocument(dbSession, {
    organizationId: identity.organizationId,
    uploadedBy: identity.userId,
    requestId: body.requestId,
    title: typeof body.title === "string" ? body.title : "",
    kind,
    contentText,
  });

  return Response.json({ document: saved, maxChars: MAX_DOCUMENT_CHARS }, { status: 201 });
}

/** DELETE /api/documents?id=… — permanently removes one document. */
async function DELETEWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "A document id is required" }, { status: 400 });
  await ensureOrganization(dbSession, identity);
  await deleteDocument(dbSession, identity.organizationId, id);
  return Response.json({ documents: await listDocuments(dbSession, identity.organizationId) });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
export const DELETE = withApiSession(DELETEWithSession);
