import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { parseOnboarding } from "@/lib/onboarding/preferences";
import { readOnboarding, writeOnboarding } from "@/lib/onboarding/storage";

const headers = { "cache-control": "no-store" };
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity || isGuestIdentity(identity)) return Response.json({ error: "Authentication required" }, { status: 401, headers });
  try { return Response.json(await readOnboarding(dbSession, identity.userId, identity.organizationId), { headers }); }
  catch { return Response.json({ error: "Preferences could not be loaded. Please retry." }, { status: 503, headers }); }
}

async function PUTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity || isGuestIdentity(identity)) return Response.json({ error: "Authentication required" }, { status: 401, headers });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const raw = await request.text();
  if (raw.length > 12000) return Response.json({ error: "Preferences are too large" }, { status: 413 });
  let state;
  try { state = parseOnboarding(JSON.parse(raw)); } catch { /* invalid JSON */ }
  if (!state) return Response.json({ error: "Invalid preferences" }, { status: 400, headers });
  try {
    const saved = await writeOnboarding(dbSession, identity.userId, identity.organizationId, state);
    if (!saved) return Response.json({ error: "Preferences changed in another tab. Reload to continue." }, { status: 409, headers });
    return Response.json(saved, { headers });
  } catch { return Response.json({ error: "Preferences could not be saved. Please retry." }, { status: 503, headers }); }
}

export const GET = withApiSession(GETWithSession);
export const PUT = withApiSession(PUTWithSession);
