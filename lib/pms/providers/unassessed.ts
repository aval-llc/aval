/**
 * Descriptors for every PMS in the catalog that nobody has researched yet.
 *
 * The rule is "every PMS in the catalog gets a descriptor" — leaving some
 * catalog-only recreates the split-brain this layer replaced. But the other rule
 * is "if we can't name why, we don't know, and unknown defaults to false", and
 * hand-writing a `permitted` claim for eighteen providers whose terms nobody has
 * read would be manufacturing exactly the kind of assertion this file exists to
 * prevent. One of those rules has to give, and it is not the second one.
 *
 * So these are derived, and they say something true and narrow:
 *
 *   read  — supported and permitted, via `notification`. This holds for any PMS
 *           on earth that can copy an address on outbound mail, which is the
 *           whole point of the seat: universality does not depend on the
 *           provider having an API or a partnership.
 *   write — `supported: false`. Not "prohibited" — unassessed. The reason names
 *           what is missing, taken from the catalog entry's own blocker text,
 *           and resolves to `unavailable` rather than `blocked` because there is
 *           no clause to quote and nobody to blame.
 *
 * A provider graduates out of here by getting a hand-written file in this
 * directory, at which point someone has actually read its terms.
 */

import type { IntegrationProvider } from "../../integrations/catalog.ts";
import type { ProviderDescriptor } from "../types.ts";

/** Providers with a researched, hand-written descriptor. Everything else is derived. */
export const HAND_WRITTEN_PMS_IDS: ReadonlySet<string> = new Set([
  "appfolio",
  "buildium",
  "doorloop",
  "entrata",
  "generic_email",
  "realpage",
  "rentmanager",
  "rentvine",
  "yardi",
]);

export function unassessedDescriptor(provider: IntegrationProvider): ProviderDescriptor {
  const missing = provider.setupBlocker ?? provider.note ?? "No API contract has been established with this provider.";
  return {
    id: provider.id,
    displayName: provider.title,
    read: {
      mechanisms: ["notification"],
      supported: true,
      permitted: true,
      note:
        `Aval has not assessed ${provider.title}'s API. Notification capture through the Aval seat works `
        + `regardless: if ${provider.title} can copy an address on its outbound mail, this workspace gets the `
        + `shared read envelope.`,
    },
    write: {
      // Inert: no mechanism means `runner` is never consulted. `desktop` is the
      // safe placeholder because it is the value that never implies Aval holding
      // a credential.
      mechanisms: [],
      runner: "desktop",
      supported: false,
      permitted: false,
      reason: `Aval has not assessed a write path for ${provider.title}. ${missing}`,
    },
  };
}

/** Build derived descriptors for every catalog PMS without a hand-written one. */
export function derivedPmsDescriptors(catalog: readonly IntegrationProvider[]): ProviderDescriptor[] {
  return catalog
    .filter((provider) => provider.category === "Leasing & PMS" && !HAND_WRITTEN_PMS_IDS.has(provider.id))
    .map(unassessedDescriptor);
}
