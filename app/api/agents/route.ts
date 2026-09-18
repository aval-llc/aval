import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { createCustomPersona, listCustomPersonas, InvalidPersonaInputError } from "@/lib/ask-aval/custom-personas";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const personas = await listCustomPersonas(dbSession, identity.organizationId);
  return Response.json({ personas });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const body = (await request.json().catch(() => ({}))) as {
    label?: string;
    focusDescription?: string;
    toolNames?: string[];
    shape?: string;
    theme?: string;
  };

  try {
    const persona = await createCustomPersona(dbSession, identity.organizationId, identity.userId, {
      label: typeof body.label === "string" ? body.label : "",
      focusDescription: typeof body.focusDescription === "string" ? body.focusDescription : "",
      toolNames: Array.isArray(body.toolNames) ? body.toolNames.filter((name) => typeof name === "string") : null,
      shape: typeof body.shape === "string" ? body.shape : "",
      theme: typeof body.theme === "string" ? body.theme : "",
    });
    return Response.json({ persona }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPersonaInputError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
