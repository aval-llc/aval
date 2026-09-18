/**
 * The per-workspace sender allowlist — storage, and the join that makes it mean
 * something.
 *
 * `verifySender` has always taken an allowlist and nothing persisted one, which
 * meant the seat could store mail and never verify a single message. This is
 * that missing half. The important function here is not `allowSender` but
 * `resolveSeatSender`: it is the join between what a message proves about itself
 * and what a workspace consented to, and either half alone decides nothing.
 *
 * Revocation is immediate and total — `revokeSender` deletes the row, and the
 * next message from that domain fails. That asymmetry against
 * `organization_seat_slugs`, where nothing is ever deleted, is the point of both
 * designs: the address is permanent so that a customer's PMS configuration keeps
 * working, and consent is revocable so that permanence never becomes a standing
 * grant nobody can take back.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { pmsSeatSenders } from "@/db/schema";
import { isPmsProvider } from "../providers/index.ts";
import {
  authenticatedDomain,
  type AuthenticationResults,
  domainMatches,
  type SenderVerdict,
  verifySender,
} from "./authentication.ts";
import {
  describeSenderDomainRejection,
  normalizeSenderDomain,
  senderDomainRejection,
} from "./sender-domain.ts";

export interface SeatSender {
  domain: string;
  providerId: string;
  addedBy: string;
  addedAt: Date;
}

export type AllowResult =
  | { ok: true; sender: SeatSender; replacedProviderId: string | null }
  | { ok: false; reason: string };

/** Every sender this workspace allows, current first by recency of the grant. */
export async function readSeatAllowlist(organizationId: string): Promise<SeatSender[]> {
  const rows = await getDb()
    .select()
    .from(pmsSeatSenders)
    .where(eq(pmsSeatSenders.organizationId, organizationId));

  return rows
    .map((row) => ({
      domain: row.domain,
      providerId: row.providerId,
      addedBy: row.addedBy,
      addedAt: row.addedAt,
    }))
    .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
}

/**
 * Just the domains, in the shape `verifySender` takes.
 *
 * An empty array is the correct and expected result for a workspace that has
 * not been through setup, and `verifySender` refuses on it. Nothing here
 * substitutes a default: the descriptors' `senderDomains` are suggestions for a
 * setup screen and are never read on the verification path.
 */
export async function allowlistedSenderDomains(organizationId: string): Promise<string[]> {
  return (await readSeatAllowlist(organizationId)).map((sender) => sender.domain);
}

/**
 * Allow a domain to write to this workspace's seat, as a given provider.
 *
 * Re-allowing a domain already on the list re-points it at the provider named
 * now, and says which provider it used to be — a domain moving between
 * providers changes how its mail will be parsed, so the caller has something
 * concrete to confirm rather than a silent overwrite.
 */
export async function allowSender(
  organizationId: string,
  domain: string,
  providerId: string,
  userId: string,
): Promise<AllowResult> {
  const normalized = normalizeSenderDomain(domain);

  if (!isPmsProvider(providerId)) {
    // A row naming a provider that does not exist would verify mail and then
    // have nowhere to send it. Checked here rather than trusted from a form.
    return { ok: false, reason: "Unknown system. Pick the PMS this domain sends from." };
  }

  const rejection = senderDomainRejection(normalized, providerId);
  if (rejection) return { ok: false, reason: describeSenderDomainRejection(rejection) };

  const db = getDb();
  const [existing] = await db
    .select({ providerId: pmsSeatSenders.providerId })
    .from(pmsSeatSenders)
    .where(and(eq(pmsSeatSenders.organizationId, organizationId), eq(pmsSeatSenders.domain, normalized)))
    .limit(1);

  const addedAt = new Date();
  const sender: SeatSender = { domain: normalized, providerId, addedBy: userId, addedAt };

  if (existing) {
    if (existing.providerId === providerId) return { ok: true, sender, replacedProviderId: null };
    await db
      .update(pmsSeatSenders)
      .set({ providerId, addedBy: userId, addedAt })
      .where(and(eq(pmsSeatSenders.organizationId, organizationId), eq(pmsSeatSenders.domain, normalized)));
    return { ok: true, sender, replacedProviderId: existing.providerId };
  }

  await db.insert(pmsSeatSenders).values({
    organizationId,
    domain: normalized,
    providerId,
    addedBy: userId,
    addedAt,
  });

  return { ok: true, sender, replacedProviderId: null };
}

/**
 * Stop reading mail from a domain. Returns false when it was not on the list.
 *
 * Takes effect on the next message with no further step, which is why the row
 * is deleted rather than flagged: a revocation that leaves a disabled row is a
 * revocation that a later code path can misread as consent.
 */
export async function revokeSender(organizationId: string, domain: string): Promise<boolean> {
  const normalized = normalizeSenderDomain(domain);
  const deleted = await getDb()
    .delete(pmsSeatSenders)
    .where(and(eq(pmsSeatSenders.organizationId, organizationId), eq(pmsSeatSenders.domain, normalized)))
    .returning({ domain: pmsSeatSenders.domain });
  return deleted.length > 0;
}

export interface SeatSenderResolution {
  verdict: SenderVerdict;
  /**
   * Which system this message is to be read as, present only when the verdict
   * verified. The read envelope parses by this and never by content — a message
   * body is the one thing in this path a sender fully controls.
   */
  providerId?: string;
}

/**
 * The join: does this message pass, and whose system is it from?
 *
 * Both answers come from the same allowlist row, which is what keeps them from
 * disagreeing. A verified message whose provider could not be determined is
 * returned unverified rather than passed to a default parser — a message that
 * authenticated against a row we then cannot find is a bug in this function,
 * and guessing a provider would hide it behind mail that parses slightly wrong.
 */
export async function resolveSeatSender(
  organizationId: string,
  auth: AuthenticationResults | null,
): Promise<SeatSenderResolution> {
  const allowlist = await readSeatAllowlist(organizationId);
  const verdict = verifySender(auth, allowlist.map((sender) => sender.domain));

  if (!verdict.verified) {
    // Report the authenticated domain even though the verdict failed, so a
    // held message can be offered for review. `verifySender` cannot do this
    // itself: it refuses an empty allowlist before reading the headers, which
    // is the right rule and also the state a workspace is in at first contact.
    const authenticated = verdict.domain ? null : authenticatedDomain(auth);
    return authenticated
      ? { verdict: { ...verdict, domain: authenticated.domain, method: authenticated.method } }
      : { verdict };
  }

  if (!verdict.domain) return { verdict };

  const matched = allowlist.find((sender) => domainMatches(verdict.domain as string, sender.domain));
  if (!matched) {
    return {
      verdict: {
        verified: false,
        domain: verdict.domain,
        reason: `${verdict.domain} authenticated but could not be matched to an allowed sender for this workspace.`,
      },
    };
  }

  return { verdict, providerId: matched.providerId };
}
