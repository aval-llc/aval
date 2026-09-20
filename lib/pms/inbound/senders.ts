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
import type { DbSession } from "@/db/postgres/session";
import { pmsSeatSenderAddresses, pmsSeatSenders } from "@/db/postgres/schema";
import { isPmsProvider } from "../providers/index.ts";
import {
  authenticatedAddress,
  authenticatedDomain,
  type AuthenticationResults,
  domainMatches,
  type SenderVerdict,
  verifySender,
} from "./authentication.ts";
import {
  describeSenderAddressRejection,
  describeSenderDomainRejection,
  normalizeSenderAddress,
  normalizeSenderDomain,
  senderAddressRejection,
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

export type AllowAddressResult =
  | { ok: true; sender: SeatSenderAddress; replacedProviderId: string | null }
  | { ok: false; reason: string };

/** Every sender this workspace allows, current first by recency of the grant. */
export async function readSeatAllowlist(dbSession: DbSession, organizationId: string): Promise<SeatSender[]> {
  const rows = await dbSession.db
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
export async function allowlistedSenderDomains(dbSession: DbSession, organizationId: string): Promise<string[]> {
  return (await readSeatAllowlist(dbSession, organizationId)).map((sender) => sender.domain);
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
  dbSession: DbSession,
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

  const rejection = senderDomainRejection(normalized);
  if (rejection) return { ok: false, reason: describeSenderDomainRejection(rejection) };

  const [existing] = await dbSession.db
    .select({ providerId: pmsSeatSenders.providerId })
    .from(pmsSeatSenders)
    .where(and(eq(pmsSeatSenders.organizationId, organizationId), eq(pmsSeatSenders.domain, normalized)))
    .limit(1);

  const addedAt = new Date();
  const sender: SeatSender = { domain: normalized, providerId, addedBy: userId, addedAt };

  if (existing) {
    if (existing.providerId === providerId) return { ok: true, sender, replacedProviderId: null };
    await dbSession.db
      .update(pmsSeatSenders)
      .set({ providerId, addedBy: userId, addedAt })
      .where(and(eq(pmsSeatSenders.organizationId, organizationId), eq(pmsSeatSenders.domain, normalized)));
    return { ok: true, sender, replacedProviderId: existing.providerId };
  }

  await dbSession.db.insert(pmsSeatSenders).values({
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
export async function revokeSender(dbSession: DbSession, organizationId: string, domain: string): Promise<boolean> {
  const normalized = normalizeSenderDomain(domain);
  const deleted = await dbSession.db
    .delete(pmsSeatSenders)
    .where(and(eq(pmsSeatSenders.organizationId, organizationId), eq(pmsSeatSenders.domain, normalized)))
    .returning({ domain: pmsSeatSenders.domain });
  return deleted.length > 0;
}

/* ── approved mailboxes ───────────────────────────────────────────────────── */

export interface SeatSenderAddress {
  address: string;
  providerId: string;
  addedBy: string;
  addedAt: Date;
}

/** Every mailbox this workspace approved, most recent grant first. */
export async function readSeatAddressAllowlist(
  dbSession: DbSession,
  organizationId: string,
): Promise<SeatSenderAddress[]> {
  const rows = await dbSession.db
    .select()
    .from(pmsSeatSenderAddresses)
    .where(eq(pmsSeatSenderAddresses.organizationId, organizationId));

  return rows
    .map((row) => ({
      address: row.address,
      providerId: row.providerId,
      addedBy: row.addedBy,
      addedAt: row.addedAt,
    }))
    .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
}

/**
 * Approve one mailbox to write to this workspace's seat.
 *
 * The narrow grant, and the only way a consumer mailbox provider is ever
 * trusted. `senderAddressRejection` permits `john@gmail.com` where
 * `senderDomainRejection` refuses `gmail.com`, and that asymmetry is the
 * design rather than an oversight: one names a person, the other names a
 * population.
 *
 * Approving a mailbox never widens into its domain. Nothing here writes to
 * `pms_seat_senders`, and `resolveSeatSender` matches an approved address
 * exactly — so `john@gmail.com` being approved leaves `attacker@gmail.com`
 * exactly as untrusted as it was.
 */
export async function allowSenderAddress(
  dbSession: DbSession,
  organizationId: string,
  address: string,
  providerId: string,
  userId: string,
): Promise<AllowAddressResult> {
  const normalized = normalizeSenderAddress(address);

  if (!isPmsProvider(providerId)) {
    return { ok: false, reason: "Unknown system. Pick the PMS this sender writes on behalf of." };
  }

  const rejection = senderAddressRejection(normalized);
  if (rejection) return { ok: false, reason: describeSenderAddressRejection(rejection) };

  const [existing] = await dbSession.db
    .select({ providerId: pmsSeatSenderAddresses.providerId })
    .from(pmsSeatSenderAddresses)
    .where(and(
      eq(pmsSeatSenderAddresses.organizationId, organizationId),
      eq(pmsSeatSenderAddresses.address, normalized),
    ))
    .limit(1);

  const addedAt = new Date();
  const sender: SeatSenderAddress = { address: normalized, providerId, addedBy: userId, addedAt };

  if (existing) {
    if (existing.providerId === providerId) return { ok: true, sender, replacedProviderId: null };
    await dbSession.db
      .update(pmsSeatSenderAddresses)
      .set({ providerId, addedBy: userId, addedAt })
      .where(and(
        eq(pmsSeatSenderAddresses.organizationId, organizationId),
        eq(pmsSeatSenderAddresses.address, normalized),
      ));
    return { ok: true, sender, replacedProviderId: existing.providerId };
  }

  await dbSession.db.insert(pmsSeatSenderAddresses).values({
    organizationId,
    address: normalized,
    providerId,
    addedBy: userId,
    addedAt,
  });

  return { ok: true, sender, replacedProviderId: null };
}

/** Stop reading mail from a mailbox. Returns false when it was not approved. */
export async function revokeSenderAddress(
  dbSession: DbSession,
  organizationId: string,
  address: string,
): Promise<boolean> {
  const normalized = normalizeSenderAddress(address);
  const deleted = await dbSession.db
    .delete(pmsSeatSenderAddresses)
    .where(and(
      eq(pmsSeatSenderAddresses.organizationId, organizationId),
      eq(pmsSeatSenderAddresses.address, normalized),
    ))
    .returning({ address: pmsSeatSenderAddresses.address });
  return deleted.length > 0;
}

/**
 * How much a message's sender was trusted, and by which rung.
 *
 * Ordered, and the order is the policy: a narrower grant is always preferred to
 * a wider one, and nothing falls *upward* into a broader trust than the one
 * that actually matched.
 */
export type SenderTrustTier =
  /**
   * A mailbox this workspace connected and authenticated itself.
   *
   * The strongest rung, and **nothing produces it yet** — Aval has no connected
   * mailbox integration. It is named here because the ladder's order is the
   * decision, and a rung added later must slot in above the others rather than
   * be argued about again.
   */
  | "connected_mailbox"
  /** An exact mailbox the workspace approved. */
  | "approved_address"
  /** A domain the workspace approved, which it must control. */
  | "approved_domain"
  /** Nothing matched. The message waits for a person. */
  | "review";

export interface SeatSenderResolution {
  verdict: SenderVerdict;
  /**
   * Which system this message is to be read as, present only when the verdict
   * verified. The read envelope parses by this and never by content — a message
   * body is the one thing in this path a sender fully controls.
   */
  providerId?: string;
  /** Which rung of the trust ladder decided this. */
  tier: SenderTrustTier;
}

/**
 * The join: does this message pass, whose system is it from, and on what basis?
 *
 * Trust is tried in one fixed order, narrowest first:
 *
 *   1. **A connected authenticated mailbox.** No producer yet; see
 *      `SenderTrustTier`.
 *   2. **An exact approved sender address.** Requires `authenticatedAddress`,
 *      which is strictly stronger than an authenticated domain — see its own
 *      documentation for why DMARC alone is not enough to trust a local part.
 *   3. **An approved organization-controlled domain.** The existing allowlist.
 *      A consumer mailbox domain can never reach this rung, because
 *      `senderDomainRejection` refuses to store one.
 *   4. **Review.** Nothing matched, so a person decides.
 *
 * The order matters in one direction only: a message may be trusted by a
 * *narrower* rung than the broadest one it would satisfy, never a wider one.
 * A workspace that approved `john@gmail.com` and nothing else resolves John at
 * rung 2 and everybody else at rung 4 — there is no rung 3 for `gmail.com` to
 * reach, which is what keeps one approval from becoming a population's.
 *
 * Both answers on a pass come from the same row, which is what keeps them from
 * disagreeing. A verified message whose provider could not be determined is
 * returned unverified rather than passed to a default parser.
 */
export async function resolveSeatSender(
  dbSession: DbSession,
  organizationId: string,
  auth: AuthenticationResults | null,
  raw: string,
): Promise<SeatSenderResolution> {
  // Rung 2. Deliberately independent of the domain allowlist: a workspace whose
  // only grant is a mailbox has an empty domain list, and `verifySender`
  // refuses an empty list before it reads a header. Asking it first would mean
  // an approved mailbox could never verify.
  const mailbox = authenticatedAddress(auth, raw);
  if (mailbox) {
    const [approved] = await dbSession.db
      .select({ providerId: pmsSeatSenderAddresses.providerId })
      .from(pmsSeatSenderAddresses)
      .where(and(
        eq(pmsSeatSenderAddresses.organizationId, organizationId),
        // Exact. No `domainMatches` here, and no subdomain latitude: the whole
        // value of this rung is that it grants one mailbox.
        eq(pmsSeatSenderAddresses.address, mailbox.address),
      ))
      .limit(1);

    if (approved) {
      return {
        verdict: {
          verified: true,
          domain: mailbox.domain,
          method: "dmarc",
          reason: `${mailbox.address} is an approved sender for this workspace, DMARC-authenticated and DKIM-signed by ${mailbox.domain}.`,
        },
        providerId: approved.providerId,
        tier: "approved_address",
      };
    }
  }

  // Rung 3.
  const allowlist = await readSeatAllowlist(dbSession, organizationId);
  const verdict = verifySender(auth, allowlist.map((sender) => sender.domain));

  if (!verdict.verified) {
    // Report the authenticated domain even though the verdict failed, so a
    // held message can be offered for review. `verifySender` cannot do this
    // itself: it refuses an empty allowlist before reading the headers, which
    // is the right rule and also the state a workspace is in at first contact.
    const authenticated = verdict.domain ? null : authenticatedDomain(auth);
    return authenticated
      ? { verdict: { ...verdict, domain: authenticated.domain, method: authenticated.method }, tier: "review" }
      : { verdict, tier: "review" };
  }

  if (!verdict.domain) return { verdict, tier: "review" };

  const matched = allowlist.find((sender) => domainMatches(verdict.domain as string, sender.domain));
  if (!matched) {
    return {
      verdict: {
        verified: false,
        domain: verdict.domain,
        reason: `${verdict.domain} authenticated but could not be matched to an allowed sender for this workspace.`,
      },
      tier: "review",
    };
  }

  return { verdict, providerId: matched.providerId, tier: "approved_domain" };
}
