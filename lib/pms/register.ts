/**
 * Adapter registration.
 *
 * The registries in `flows.ts` and `grants.ts` are module-level maps, so
 * something has to fill them before the first resolution. Doing it here rather
 * than as an import side effect keeps the order explicit: a provider that is not
 * registered resolves to `unlearned`, and that should be a visible consequence
 * of not calling this, not an accident of module evaluation order.
 *
 * Idempotent, because both the resolver and the executor call it and either may
 * be the first to run in a given isolate.
 */

import { registerDoorLoop } from "./adapters/doorloop.ts";

let registered = false;

export function ensurePmsAdaptersRegistered(): void {
  if (registered) return;
  registered = true;
  registerDoorLoop();
}
