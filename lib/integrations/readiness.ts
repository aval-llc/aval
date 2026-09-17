import { getProvider, MODEL_PROVIDER_IDS } from "./catalog";

/** One truth for the server and UI. A catalog tile is not an adapter. */
const EXISTING_BLOCKERS: Readonly<Record<string, string>> = {
  reapit: "Reapit customer installation and approved app permissions are required. Account verification and the data adapter still need sandbox validation.",
  arthur: "Arthur entity selection and its account-specific read contract still need implementation and sandbox validation.",
  appfolio: "AppFolio Stack product approval and the contracted API specification are required to implement and certify this adapter.",
  yardi: "Obtain the approved Voyager interface specification, licensing and sandbox. The adapter still needs implementation against that contract.",
  realpage: "RealPage Exchange partner access, endpoint documentation and a sandbox are required to finish the adapter.",
  entrata: "Obtain the Entrata API agreement, tenant endpoint and IP allowlisting. This adapter is not implemented yet.",
  rentmanager: "Rent Manager partner API documentation and a sandbox are required to finish the adapter.",
  contpaqi: "Choose the CONTPAQi API product and obtain its authentication contract. This adapter is not implemented yet.",
  alegra: "The existing single-key setup is insufficient for Alegra authentication. This adapter still needs the account email/token flow and mapping.",
  doorloop: "DoorLoop credential storage exists, but its data adapter still needs implementation and sandbox validation.",
  whatsapp_personal: "A personal WhatsApp linked-device runtime is not implemented. Use WhatsApp Business for the official supported API connection.",
  apple_messages: "Apple Messages for Business requires an approved MSP and its specific send/webhook contract. The MSP adapter is not implemented yet.",
};
export function connectionBlocker(provider: string): string | null {
  return getProvider(provider)?.setupBlocker ?? EXISTING_BLOCKERS[provider] ?? null;
}
// QuickBooks imports have a durable worker; other providers verify access only.
export function integrationReadiness(provider: string) {
  const configured = getProvider(provider);
  const blocker = connectionBlocker(provider);
  return { status: !configured || blocker ? "unavailable" : "credentials_required", blocker, verification: Boolean(configured && !blocker), sync: provider === "quickbooks" || provider === "buildium", model: Boolean(configured && MODEL_PROVIDER_IDS.has(configured.id)), liveValidated: false };
}
