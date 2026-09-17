import type { ProviderDescriptor } from "../types.ts";

/**
 * DoorLoop — the reference provider, and the only one where maintenance writes
 * can go live without anyone signing anything.
 *
 * The API key is self-serve from account settings, the terms carry no automation
 * prohibition, and writes are real REST calls. That makes DoorLoop the place the
 * write path gets proven end to end: if the machinery only works where we also
 * had to negotiate access, we have not tested the machinery.
 */
export const doorloop: ProviderDescriptor = {
  id: "doorloop",
  displayName: "DoorLoop",

  read: {
    mechanisms: ["api"],
    supported: true,
    permitted: true,
    note: "Public self-serve API key generated in DoorLoop account settings. No partner program.",
  },

  write: {
    mechanisms: ["api"],
    runner: "cloud",
    supported: true,
    permitted: true,
    note: "Scoped by the key's own permissions, so grant discovery is authoritative here rather than advisory.",
  },
};
