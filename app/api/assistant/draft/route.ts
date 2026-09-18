import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { env } from "cloudflare:workers";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { handleAskAvalDraft, type DraftFormat } from "@/lib/ask-aval/draft";
import type { AskAvalEnv } from "@/lib/ask-aval/model-types";
import {
  reserveDraft,
  finishDraft,
  validDraftId,
} from "@/lib/ask-aval/draft-store";

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity)
    return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    title?: string;
    instructions?: string;
    format?: string;
    locale?: string;
    moduleLabel?: string;
    moduleSnapshot?: string;
    documentType?: string;
    personaId?: string;
  };
  const title = typeof body.title === "string" ? body.title : "";
  const instructions =
    typeof body.instructions === "string" ? body.instructions : "";
  const format: DraftFormat =
    body.format === "xlsx" || body.format === "pptx" ? body.format : "docx";
  const documentType =
    typeof body.documentType === "string"
      ? body.documentType.trim().slice(0, 60)
      : "";
  const locale = body.locale === "es-mx" ? "es-mx" : "en";
  const focusedModule = body.moduleLabel
    ? { label: body.moduleLabel, snapshot: body.moduleSnapshot ?? "" }
    : undefined;

  const id = body.id ?? crypto.randomUUID();
  if (!validDraftId(id))
    return Response.json({ error: "Invalid draft ID" }, { status: 400 });
  const token = await reserveDraft(dbSession, identity, id, {
    title,
    instructions,
    format,
    documentType: documentType || null,
    moduleLabel: focusedModule?.label ?? null,
  });
  if (!token)
    return Response.json({ error: "This draft was removed." }, { status: 409 });
  const response = await handleAskAvalDraft(dbSession,
    { title, instructions, format },
    env as unknown as AskAvalEnv,
    { orgId: identity.organizationId, userId: identity.userId },
    locale,
    focusedModule,
    body.personaId,
    isGuestIdentity(identity),
  );

  await finishDraft(dbSession, identity, id, token, response);

  return response;
}

export const POST = withApiSession(POSTWithSession);
