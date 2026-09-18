import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * The workspaces a user can act in, and switching between them.
 *
 * Switching rewrites the session cookie's workspace claim. That claim is not
 * authority — `resolveMembership` re-reads membership on every request — so a
 * request to switch into a workspace the user does not belong to is refused
 * here, and would degrade to their own workspace even if it were not.
 */

import { getApiIdentity, isGuestIdentity, organizationIdForUser } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { listWorkspacesForUser, acceptInvitation, roleFor } from "@/lib/organizations/membership";
import { activeOrganizationCookie } from "@/lib/auth/supabase";
import { isRateLimited, recordAttempt } from "@/lib/security/rate-limit";

/** Codes are guessable only by brute force; this is what keeps that expensive. */
const REDEEM_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) return Response.json({ error: "Sign in to see your workspaces." }, { status: 403 });
  await ensureOrganization(dbSession, identity);
  const personal = await organizationIdForUser(identity.userId);
  return Response.json({
    active: identity.organizationId,
    role: identity.role,
    workspaces: await listWorkspacesForUser(dbSession, identity.userId, personal),
  }, { headers: { "cache-control": "no-store" } });
}

/** Switch workspaces, or redeem an invitation code and switch into that one. */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.source !== "password") {
    // Only a session cookie can carry a workspace choice. Platform-injected
    // identity has nowhere to put one, so switching would silently not stick.
    return Response.json({ error: "Switching workspaces requires a signed-in Aval account." }, { status: 403 });
  }
  await ensureOrganization(dbSession, identity);

  const body = (await request.json().catch(() => ({}))) as { organizationId?: string; code?: string };
  let target: string;

  if (typeof body.code === "string" && body.code.trim()) {
    const scope = `invite-redeem:${identity.userId}`;
    if (await isRateLimited(dbSession, scope, REDEEM_LIMIT)) {
      return Response.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });
    }
    await recordAttempt(dbSession, scope);
    const accepted = await acceptInvitation(dbSession, body.code, identity.userId);
    if (!accepted.ok) {
      const message = accepted.reason === "already_member" ? "You are already in that workspace."
        : accepted.reason === "expired" ? "That invitation has expired. Ask the owner for a new one."
        : accepted.reason === "already_accepted" ? "That invitation has already been used."
        : accepted.reason === "revoked" ? "That invitation was revoked."
        : "That invitation code is not valid.";
      return Response.json({ error: message }, { status: 400 });
    }
    target = accepted.organizationId;
  } else if (typeof body.organizationId === "string" && body.organizationId) {
    target = body.organizationId;
    if (!(await roleFor(dbSession, identity.userId, target))) {
      // Refused rather than silently ignored: a switcher that appears to work
      // and does not is worse than one that says no.
      return Response.json({ error: "You do not have access to that workspace." }, { status: 403 });
    }
  } else {
    return Response.json({ error: "organizationId or code is required" }, { status: 400 });
  }

  const cookie = activeOrganizationCookie(request, target);
  const personal = await organizationIdForUser(identity.userId);
  return new Response(JSON.stringify({
    active: target,
    role: await roleFor(dbSession, identity.userId, target),
    workspaces: await listWorkspacesForUser(dbSession, identity.userId, personal),
  }), { status: 200, headers: { "content-type": "application/json", "set-cookie": cookie } });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
