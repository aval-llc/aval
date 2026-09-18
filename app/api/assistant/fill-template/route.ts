import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * POST /api/assistant/fill-template
 *
 * multipart/form-data: `template` (a .docx file with {{tag}} placeholders)
 * and `data` (a JSON object of tag → value). Returns the filled .docx as a
 * binary download — stateless, on demand; there is no template-storage
 * surface yet (see docs/DECISIONS.md), so the caller supplies the template
 * bytes on every call.
 */

import { getApiIdentity } from "@/lib/integrations/session";
import { renderDocxFromTemplate, DocxTemplateError } from "@/lib/ask-aval/docx-template";

const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "Expected multipart/form-data with `template` and `data` fields" }, { status: 400 });

  const templateFile = form.get("template");
  if (!(templateFile instanceof File)) return Response.json({ error: "A `template` .docx file is required" }, { status: 400 });
  if (templateFile.size > MAX_TEMPLATE_BYTES) return Response.json({ error: "Template file is too large (5MB max)" }, { status: 400 });

  const rawData = form.get("data");
  let data: Record<string, unknown> = {};
  if (typeof rawData === "string" && rawData.trim()) {
    try {
      data = JSON.parse(rawData);
    } catch {
      return Response.json({ error: "`data` must be valid JSON" }, { status: 400 });
    }
  }

  try {
    const templateBytes = new Uint8Array(await templateFile.arrayBuffer());
    const filled = renderDocxFromTemplate(templateBytes, data);
    const filename = (templateFile.name || "document.docx").replace(/[^a-zA-Z0-9 ._-]/g, "_");
    // TS's stricter typed-array generics don't accept pizzip's
    // Uint8Array<ArrayBufferLike> as a BlobPart directly — copying into a
    // fresh Uint8Array guarantees a plain ArrayBuffer underneath.
    return new Response(new Blob([Uint8Array.from(filled)]), {
      headers: {
        "content-type": DOCX_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof DocxTemplateError) return Response.json({ error: err.message }, { status: 400 });
    console.error("fill_template_unhandled", err);
    return Response.json({ error: "The template could not be processed." }, { status: 500 });
  }
}

export const POST = withApiSession(POSTWithSession);
