/**
 * Storage for ingested documents. Every read is org-scoped — a document from
 * another workspace is invisible here, same as every other row in this app.
 */

import { and, desc, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { documents } from "@/db/postgres/schema";
import { MAX_DOCUMENT_CHARS, MAX_DOCUMENT_TITLE_CHARS, type DocumentKind, type StoredDocument } from "./types";

export interface SaveDocumentInput {
  organizationId: string;
  uploadedBy: string;
  requestId?: string;
  title: string;
  kind: DocumentKind;
  contentText: string;
}

export interface SavedDocument extends StoredDocument {
  /** True when the text ran past MAX_DOCUMENT_CHARS and the tail was dropped. */
  truncated: boolean;
}

/**
 * Saves a document, truncating over-long text rather than rejecting it.
 *
 * Truncation is reported back so the caller can say so plainly: silently
 * storing the first 60k characters of a 90k-character lease would make every
 * later answer about that lease quietly unreliable, with nothing on screen to
 * indicate why.
 */
export async function saveDocument(dbSession: DbSession, input: SaveDocumentInput): Promise<SavedDocument> {
  const title = input.title.trim().slice(0, MAX_DOCUMENT_TITLE_CHARS) || "Untitled document";
  const full = input.contentText.trim();
  const contentText = full.slice(0, MAX_DOCUMENT_CHARS);
  const id = input.requestId
    ? "upload_" + Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([input.organizationId,input.uploadedBy,input.requestId]))))).map(b=>b.toString(16).padStart(2,"0")).join("")
    : crypto.randomUUID();
  const createdAt = new Date();

  await dbSession.db.insert(documents).values({
    id,
    organizationId: input.organizationId,
    title,
    kind: input.kind,
    contentText,
    charCount: contentText.length,
    uploadedBy: input.uploadedBy,
    createdAt,
  }).onConflictDoNothing();

  if (input.requestId) {
    const stored = await getDocument(dbSession, input.organizationId, id);
    if (!stored || stored.contentText !== contentText || stored.title !== title || stored.kind !== input.kind) throw new Error("Upload request was reused with different content");
    return { id: stored.id, title: stored.title, kind: stored.kind, charCount: stored.charCount, createdAt: stored.createdAt, truncated: full.length > contentText.length };
  }

  return { id, title, kind: input.kind, charCount: contentText.length, createdAt, truncated: full.length > contentText.length };
}

/** Document metadata for a workspace, newest first. Bodies are not read here. */
export async function listDocuments(dbSession: DbSession, organizationId: string): Promise<StoredDocument[]> {
  const rows = await dbSession.db
    .select({ id: documents.id, title: documents.title, kind: documents.kind, charCount: documents.charCount, createdAt: documents.createdAt })
    .from(documents)
    .where(eq(documents.organizationId, organizationId))
    .orderBy(desc(documents.createdAt));
  return rows.map((row) => ({ ...row, kind: row.kind as DocumentKind }));
}

/** One document with its text, or null if it doesn't exist in this organization. */
export async function getDocument(dbSession: DbSession, organizationId: string, documentId: string): Promise<(StoredDocument & { contentText: string }) | null> {
  const [row] = await dbSession.db
    .select()
    .from(documents)
    .where(and(eq(documents.organizationId, organizationId), eq(documents.id, documentId)))
    .limit(1);
  if (!row) return null;
  return { id: row.id, title: row.title, kind: row.kind as DocumentKind, charCount: row.charCount, createdAt: row.createdAt, contentText: row.contentText };
}

/** Permanently removes a document. Scoped so one workspace cannot delete another's row. */
export async function deleteDocument(dbSession: DbSession, organizationId: string, documentId: string): Promise<void> {
  await dbSession.db.delete(documents).where(and(eq(documents.organizationId, organizationId), eq(documents.id, documentId)));
}
