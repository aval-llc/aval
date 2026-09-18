/**
 * GET  /api/pms/seat  — this workspace's seat address, who may write to it, and what is waiting.
 * POST /api/pms/seat  — claim an address, allow a sender, or revoke one.
 *
 * The whole seat path was headless before this: a slug could be claimed and a
 * sender allowed only from a test. That matters more than a missing screen,
 * because `verifySender` refuses every message until a workspace has allowed a
 * domain — so with no surface, the seat stored mail and verified none of it.
 *
 * ## What this endpoint will not render
 *
 * Held senders come from `seatReview()`, which returns only domains that
 * *authenticated*. A held message's `From` is chosen by whoever sent it, and
 * this response is read by a component that draws an Allow button next to each
 * one. Mail that authenticated nothing is returned as a count with no domain,
 * and `pms_seat_messages.authenticated_domain` is null for exactly those rows —
 * the control is in storage, not in this file's good behaviour.
 *
 * Nothing here reads R2. The app Worker has no handle on the unverified inbox
 * (`d9210f8`); the reader Worker writes what this reads.
 */

import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { roleFor } from "@/lib/organizations/membership";
import { canManagePolicy } from "@/lib/organizations/roles";
import { connectedPmsProviders } from "@/lib/pms/assembly.ts";
import { pmsProvider } from "@/lib/pms/providers/index.ts";
import { seatReview } from "@/lib/pms/inbound/messages.ts";
import { claimSeatSlug, seatAddressesFor } from "@/lib/pms/inbound/seats.ts";
import { suggestedSenderDomains } from "@/lib/pms/inbound/sender-domain.ts";
import { allowSender, readSeatAllowlist, revokeSender } from "@/lib/pms/inbound/senders.ts";

/**
 * `generic_email` is always offerable, even when no PMS is connected.
 *
 * It is what makes the seat universal: a system nobody has integrated can still
 * copy the address on its notifications. Leaving it out of the picker would mean
 * the customers the seat exists for could not use it.
 */
const ALWAYS_OFFERED = "generic_email";

async function providerChoices(organizationId: string) {
  const connected = await connectedPmsProviders(organizationId);
  const ids = [...new Set([...connected, ALWAYS_OFFERED])];
  return ids.map((id) => ({
    id,
    displayName: pmsProvider(id)?.displayName ?? id,
    senderDomains: pmsProvider(id)?.senderDomains ?? [],
  }));
}

export async function GET(request: Request) {
  const identity = await getApiIdentity(request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  try {
    await ensureOrganization(identity);
    const [addresses, allowlist, review, choices, role] = await Promise.all([
      seatAddressesFor(identity.organizationId),
      readSeatAllowlist(identity.organizationId),
      seatReview(identity.organizationId),
      providerChoices(identity.organizationId),
      roleFor(identity.userId, identity.organizationId).catch(() => null),
    ]);

    const held = allowlist.map((sender) => sender.domain);

    return Response.json({
      address: addresses.primary,
      // Every address this workspace has ever held. A renamed workspace keeps
      // its old ones working, and a customer whose PMS still has the old one on
      // file needs to see that it is still theirs.
      addresses: addresses.all,
      allowlist: allowlist.map((sender) => ({
        domain: sender.domain,
        providerId: sender.providerId,
        displayName: pmsProvider(sender.providerId)?.displayName ?? sender.providerId,
        addedAt: sender.addedAt.toISOString(),
      })),
      providers: choices.map((choice) => ({
        id: choice.id,
        displayName: choice.displayName,
        // Researched, not observed. The component says so, because a customer
        // ticking a suggestion is the one confirming it.
        suggestions: suggestedSenderDomains(choice.senderDomains, choice.id, held),
      })),
      review: {
        held: review.held.map((sender) => ({
          domain: sender.domain,
          method: sender.method,
          messages: sender.messages,
          firstSeen: sender.firstSeen.toISOString(),
          lastSeen: sender.lastSeen.toISOString(),
        })),
        unauthenticated: {
          messages: review.unauthenticated.messages,
          lastSeen: review.unauthenticated.lastSeen?.toISOString() ?? null,
        },
        verified: review.verified,
      },
      canEdit: Boolean(role && canManagePolicy(role)) && !isGuestIdentity(identity),
    });
  } catch (error) {
    // Same shape as /api/pms/matrix: a workspace without D1 sees an inert panel
    // rather than an error page.
    return Response.json({
      address: null,
      addresses: [],
      allowlist: [],
      providers: [],
      review: { held: [], unauthenticated: { messages: 0, lastSeen: null }, verified: 0 },
      canEdit: false,
      storage: "unavailable",
      detail: error instanceof Error ? error.message : "D1 is unavailable",
    });
  }
}

export async function POST(request: Request) {
  const identity = await getApiIdentity(request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  // A demo workspace must not be able to claim a real address or consent to a
  // real sender. Both outlive the demo: the slug is permanent, and the consent
  // governs what reaches an agent.
  if (isGuestIdentity(identity)) return Response.json({ error: "Not available in the demo workspace" }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const intent = typeof payload.intent === "string" ? payload.intent : "";

  await ensureOrganization(identity);

  // Owner-only, the same gate as PMS write authorization. Allowing a sender
  // decides what may enter an agent's context and claiming a slug hands a
  // customer an address they cannot change later; neither is a preference.
  const role = await roleFor(identity.userId, identity.organizationId).catch(() => null);
  if (!role || !canManagePolicy(role)) {
    return Response.json({ error: "Only the workspace owner can change the Aval seat" }, { status: 403 });
  }

  if (intent === "claim") {
    const slug = typeof payload.slug === "string" ? payload.slug : "";
    const claim = await claimSeatSlug(identity.organizationId, slug, identity.userId);
    if (!claim.ok) return Response.json({ error: claim.reason }, { status: 422 });
    return Response.json({ slug: claim.slug, address: claim.address, alias: claim.alias });
  }

  if (intent === "allow") {
    const domain = typeof payload.domain === "string" ? payload.domain : "";
    const providerId = typeof payload.providerId === "string" ? payload.providerId : "";
    const allowed = await allowSender(identity.organizationId, domain, providerId, identity.userId);
    if (!allowed.ok) return Response.json({ error: allowed.reason }, { status: 422 });
    return Response.json({
      domain: allowed.sender.domain,
      providerId: allowed.sender.providerId,
      // A domain that moved provider changes how its mail will be parsed. The
      // component says so rather than the change happening silently.
      replacedProviderId: allowed.replacedProviderId,
      // Held mail is re-read by the next sweep, not by this request. Saying when
      // is better than a screen that looks like it did nothing.
      pendingSweep: true,
    });
  }

  if (intent === "revoke") {
    const domain = typeof payload.domain === "string" ? payload.domain : "";
    const revoked = await revokeSender(identity.organizationId, domain);
    return Response.json({ domain, revoked });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
}
