/**
 * Claiming and resolving seat addresses — the storage behind
 * `seat-address.ts`'s rules.
 *
 * Same split as `capability-rules.ts` / `capability.ts`: what a seat address *is*
 * has no database in it, and this does the reads and writes.
 *
 * The one invariant worth stating plainly, because every function here exists to
 * hold it: **a slug belongs to one workspace forever.** Rows in
 * `organization_seat_slugs` are never deleted and never moved. A workspace that
 * renames gains a slug and keeps the old one resolving. Nothing in this module
 * can transfer a slug between workspaces, and that is deliberate — the address
 * lives in a customer's PMS configuration, outside our control, and mail sent to
 * it years later must never reach a stranger.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations, organizationSeatSlugs } from "@/db/schema";
import { describeSlugRejection, seatAddress, seatSlugOf, slugRejection } from "./seat-address.ts";

export type ClaimResult =
  | { ok: true; slug: string; address: string; alias: boolean }
  | { ok: false; reason: string };

/**
 * Give a workspace a seat address, or add another one to it.
 *
 * Claiming a slug this workspace already holds re-promotes it — that is how a
 * workspace switches back to an earlier address. Claiming one another workspace
 * holds fails, and cannot be made to succeed by any argument to this function.
 */
export async function claimSeatSlug(
  organizationId: string,
  slug: string,
  userId: string,
): Promise<ClaimResult> {
  const normalized = slug.trim().toLowerCase();
  const rejection = slugRejection(normalized);
  if (rejection) return { ok: false, reason: describeSlugRejection(rejection) };

  const db = getDb();
  const [existing] = await db
    .select({ organizationId: organizationSeatSlugs.organizationId })
    .from(organizationSeatSlugs)
    .where(eq(organizationSeatSlugs.slug, normalized))
    .limit(1);

  if (existing && existing.organizationId !== organizationId) {
    // Deliberately does not say which workspace holds it. The set of live seat
    // addresses is not something an unrelated operator should be able to
    // enumerate by trying names in a setup field.
    return { ok: false, reason: "That address is already taken. Choose another." };
  }

  const alias = existing !== undefined;
  if (!alias) {
    await db.insert(organizationSeatSlugs).values({
      slug: normalized,
      organizationId,
      createdBy: userId,
      createdAt: new Date(),
    });
  }

  await db
    .update(organizations)
    .set({ seatSlug: normalized, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));

  return { ok: true, slug: normalized, address: seatAddress(normalized), alias };
}

/** Which workspace a slug belongs to, including retired-but-still-live aliases. */
export async function organizationForSeatSlug(slug: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ organizationId: organizationSeatSlugs.organizationId })
    .from(organizationSeatSlugs)
    .where(eq(organizationSeatSlugs.slug, slug.trim().toLowerCase()))
    .limit(1);
  return row?.organizationId ?? null;
}

/**
 * Which workspace an inbound message was addressed to, or null.
 *
 * Null covers three different things on purpose — not a seat address, a
 * well-formed slug nobody ever claimed, and a slug that is not this domain's —
 * because none of them is a message we may act on, and distinguishing them for
 * the caller would invite a caller that treats one of them as good enough.
 */
export async function organizationForRecipient(recipient: string): Promise<string | null> {
  const slug = seatSlugOf(recipient);
  return slug === null ? null : organizationForSeatSlug(slug);
}

/** Every address that reaches this workspace, current one first. */
export async function seatAddressesFor(organizationId: string): Promise<{
  primary: string | null;
  all: string[];
}> {
  const db = getDb();
  const [org] = await db
    .select({ seatSlug: organizations.seatSlug })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  const rows = await db
    .select({ slug: organizationSeatSlugs.slug })
    .from(organizationSeatSlugs)
    .where(eq(organizationSeatSlugs.organizationId, organizationId));

  const primary = org?.seatSlug ?? null;
  const all = rows
    .map((row) => row.slug)
    .sort((a, b) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)))
    .map(seatAddress);

  return { primary: primary ? seatAddress(primary) : null, all };
}

/**
 * Whether this workspace still holds a slug it once claimed.
 *
 * Used by the settings surface to show retired aliases as live rather than
 * gone — an operator who renamed should be able to see that the old address
 * still works, because their PMS may well still be using it.
 */
export async function workspaceHoldsSlug(organizationId: string, slug: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ slug: organizationSeatSlugs.slug })
    .from(organizationSeatSlugs)
    .where(
      and(
        eq(organizationSeatSlugs.organizationId, organizationId),
        eq(organizationSeatSlugs.slug, slug.trim().toLowerCase()),
      ),
    )
    .limit(1);
  return row !== undefined;
}
