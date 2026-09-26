import { env } from "cloudflare:workers";
import { buildiumBase } from "./buildium";
import { verifyAdditionalCredentials } from "./verification";
import { providerJson, record, requiredString, safeSegment } from "./http";
import { isModelProviderId, verifyModelProviderKey } from "./model-providers";
import { byDesignConnectionConfig, probeByDesignCollection } from "./sap-bydesign/odata.ts";

const bindings = () => env as unknown as Record<string, string | undefined>;

function basic(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export async function verifyCredentials(provider: string, credentials: Record<string, string>, request: Request, connectionId: string, configureWebhook = true) {
  if (provider === "sap_bydesign") {
    const config = byDesignConnectionConfig(credentials);
    const probe = await probeByDesignCollection(config, { username: credentials.username, password: credentials.password });
    const host = new URL(config.tenantUrl).hostname;
    return { accountId: `${host}/${config.companyFilter.value}`, accountName: `SAP ByDesign · ${config.companyFilter.value}`,
      metadata: { validation: "read_access_only", mappingRequired: true, syncEnabled: false, ...probe } };
  }
  if (isModelProviderId(provider)) return verifyModelProviderKey(provider, credentials.apiKey);
  const additional = await verifyAdditionalCredentials(provider, credentials, bindings());
  if (additional) return additional;
  if (provider === "telegram") {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(credentials.botToken) || !/^[A-Za-z0-9_-]{1,256}$/.test(credentials.webhookSecret)) throw new Error("Invalid Telegram bot token or webhook secret");
    const payload = await providerJson(`https://api.telegram.org/bot${credentials.botToken}/getMe`);
    const result = record(record(payload).result);
    const origin = new URL(request.url).origin;
    if (configureWebhook) await providerJson(`https://api.telegram.org/bot${credentials.botToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${origin}/api/webhooks/telegram?connection=${encodeURIComponent(connectionId)}`, secret_token: credentials.webhookSecret, allowed_updates: ["message", "edited_message", "callback_query"] }),
    });
    return { accountId: requiredString(result.id), accountName: requiredString(result.username ?? "Telegram bot"), metadata: { webhook: "verified" } };
  }
  if (provider === "granola") {
    const payload = await providerJson("https://public-api.granola.ai/v1/notes", { headers: { authorization: `Bearer ${credentials.apiKey}` } });
    return { accountId: "granola", accountName: "Granola workspace", metadata: { hasNotes: Array.isArray(record(payload).notes) && (record(payload).notes as unknown[]).length > 0 } };
  }
  if (provider === "buildium") {
    await providerJson(`${buildiumBase(credentials.environment)}/rentals?limit=1`, { headers: { "x-buildium-client-id": credentials.clientId, "x-buildium-client-secret": credentials.clientSecret } });
    return { accountId: `${credentials.environment}:${credentials.clientId}`, accountName: `Buildium ${credentials.environment}`, metadata: { api: "verified", environment: credentials.environment, validation: "credentials_only" } };
  }
  if (provider === "twilio") {
    const payload = await providerJson(`https://api.twilio.com/2010-04-01/Accounts/${safeSegment(credentials.accountSid)}.json`, { headers: { authorization: basic(credentials.accountSid, credentials.authToken) } });
    return { accountId: requiredString(record(payload).sid), accountName: requiredString(record(payload).friendly_name ?? "Twilio account"), metadata: { api: "verified" } };
  }
  if (provider === "whatsapp") {
    const version = credentials.graphApiVersion || bindings().META_GRAPH_API_VERSION;
    if (!version || !/^v\d+\.\d+$/.test(version)) throw new Error("A Meta Graph API version must be configured before verification.");
    const payload = await providerJson(`https://graph.facebook.com/${version}/${safeSegment(credentials.phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { authorization: `Bearer ${credentials.accessToken}` } });
    return { accountId: requiredString(record(payload).id), accountName: requiredString(record(payload).verified_name ?? record(payload).display_phone_number ?? "WhatsApp number"), metadata: { businessAccountId: credentials.businessAccountId, apiVersion: version } };
  }
  throw new Error("No verification method is configured for this provider yet.");
}
