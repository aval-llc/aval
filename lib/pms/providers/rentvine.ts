import type { ProviderDescriptor } from "../types.ts";

/**
 * Rentvine — open API by product philosophy, not by exception.
 *
 * Rentvine publicly documents AppFolio's API restrictions as a reason to choose
 * them, which makes them an unusually safe provider to lead with: the write path
 * we want is a feature they advertise rather than a gap we are exploiting.
 *
 * Not present in `lib/integrations/catalog.ts` yet — added here first because
 * the descriptor is now the authoritative record and the catalog derives from it.
 */
export const rentvine: ProviderDescriptor = {
  id: "rentvine",
  displayName: "Rentvine",

  read: {
    mechanisms: ["api"],
    supported: true,
    permitted: true,
    note: "Documented public API. No partner gate.",
  },

  write: {
    mechanisms: ["api"],
    runner: "cloud",
    supported: true,
    permitted: true,
  },
};
