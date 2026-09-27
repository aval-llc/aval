import { additionalProviders, type AdditionalProviderId } from "./additional-providers.ts";

export type ProviderId = AdditionalProviderId
  | "sap_bydesign"
  | "quickbooks"
  | "xero"
  | "contpaqi"
  | "alegra"
  | "appfolio"
  | "buildium"
  | "yardi"
  | "realpage"
  | "entrata"
  | "rentmanager"
  | "doorloop"
  | "generic_email"
  | "whatsapp"
  | "whatsapp_personal"
  | "apple_messages"
  | "slack"
  | "notion"
  | "outlook"
  | "gmail"
  | "telegram"
  | "twilio"
  | "granola"
  | "openai"
  | "google_gemini"
  | "openrouter"
  | "moonshot"
  | "zai"
  | "deepseek"
  | "alibaba_model_studio"
  | "siliconflow"
  | "claude"
  | "chatgpt";

export type IntegrationProvider = {
  id: ProviderId;
  title: string;
  category: "Accounting" | "Leasing & PMS" | "Communication" | "Knowledge" | "Model" | "Marketing";
  description: string;
  /** "oauth_subscription_paste" — see lib/integrations/subscription-oauth.ts's file comment for exactly why this can't be a normal server-redirect "oauth2" flow. */
  /**
   * How a workspace proves it may use this provider.
   *
   * `customer_desktop_session` is the odd one and the reason this is a union
   * rather than a boolean: there is nothing to collect. The customer signs into
   * the provider themselves, on their own machine, and Aval operates inside the
   * session they established. No password, no authenticator seed, and no field
   * in which either could be typed — so a connection in this mode carries no
   * ciphertext at all.
   */
  authMode: "oauth2" | "credentials" | "bot_token" | "api_key" | "msp" | "qr_link"
    | "oauth_subscription_paste" | "customer_desktop_session";
  permissions: string[];
  credentialFields?: { key: string; label: string; secret?: boolean }[];
  env: string[];
  webhook: boolean;
  /**
   * Absent for every PMS provider: `lib/pms/derive.ts` computes it from that
   * provider's descriptor instead. Kept for accounting, messaging and model
   * connections, whose write posture the PMS layer does not describe. Read it
   * through `providerIsReadOnly`, never directly — a literal here on a PMS
   * provider is the split-brain this field used to be.
   */
  readOnly?: boolean;
  note: string;
  /** Explicitly unavailable adapters must never become connected from a saved key. */
  setupBlocker?: string;
  documentationUrl?: string;
  /** Model providers only — the OpenAI-compatible chat-completions base URL lib/ask-aval/openai-compatible.ts calls. Absent for Anthropic (native Messages API) and every non-model provider. */
  baseUrl?: string;
  /** Model providers only — shown as the default model id; users can override per-connection later. */
  defaultModel?: string;
  /** Subscription providers only (authMode "oauth_subscription_paste") — the API-key provider this connection is an alternative to. The UI folds this provider's "connect" affordance into that provider's own card instead of listing it separately (mentari2.0's "twin" pattern). */
  subscriptionOf?: ProviderId;
};

export const MODEL_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set([
  "openai",
  "google_gemini",
  "openrouter",
  "moonshot",
  "zai",
  "deepseek",
  "alibaba_model_studio",
  "siliconflow",
  "claude",
  "chatgpt",
]);

export const integrationCatalog: IntegrationProvider[] = [
  ...additionalProviders,
  {
    id: "sap_bydesign",
    title: "SAP Business ByDesign",
    category: "Accounting",
    description: "Connect a company-scoped, read-only SAP service for the utilities pilot.",
    authMode: "credentials",
    permissions: ["Read the configured company and collection only"],
    credentialFields: [
      { key: "tenantUrl", label: "SAP address" },
      { key: "username", label: "Integration username" },
      { key: "password", label: "Integration password", secret: true },
      { key: "collectionPath", label: "OData collection path" },
      { key: "companyField", label: "Company field name" },
      { key: "companyId", label: "Company ID" },
      { key: "recordKeyFields", label: "Unique record fields (comma-separated)" },
    ],
    env: [], webhook: false, readOnly: true,
    note: "Your SAP administrator supplies the enabled service and field names. Verification checks read access only. Utility mapping and a reviewed import are required before data reaches Aval; automatic syncing is not enabled.",
  },
  {
    id: "quickbooks",
    title: "QuickBooks Online",
    category: "Accounting",
    description: "Read receivables, payments, invoices, chart of accounts, and operating reports.",
    authMode: "oauth2",
    permissions: ["com.intuit.quickbooks.accounting"],
    env: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"],
    webhook: true,
    readOnly: true,
    note: "OAuth 2.0; Aval requests an accounting connection and only issues read calls.",
  },
  {
    id: "xero",
    title: "Xero",
    category: "Accounting",
    description: "Read invoices, payments, bank transactions, contacts, and financial reports.",
    authMode: "oauth2",
    permissions: ["openid", "profile", "email", "offline_access", "accounting.invoices.read", "accounting.payments.read", "accounting.banktransactions.read", "accounting.contacts.read", "accounting.settings.read", "accounting.reports.profitandloss.read", "accounting.reports.balancesheet.read"],
    env: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"],
    webhook: false,
    readOnly: true,
    note: "Uses Xero's granular read scopes introduced in 2026.",
  },
  {
    id: "contpaqi",
    title: "CONTPAQi",
    category: "Accounting",
    description: "Read facturación, cuentas por cobrar, and accounting reports for operators in Mexico.",
    authMode: "api_key",
    permissions: ["Accounting data"],
    credentialFields: [{ key: "apiKey", label: "CONTPAQi API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Requires a CONTPAQi license with API access enabled.",
  },
  {
    id: "alegra",
    title: "Alegra",
    category: "Accounting",
    description: "Read facturación, receivables, and payments for small and mid-size businesses across LatAm.",
    authMode: "api_key",
    permissions: ["Accounting data"],
    credentialFields: [{ key: "apiKey", label: "Alegra API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Authenticates with an Alegra API key.",
  },
  {
    id: "appfolio",
    title: "AppFolio",
    category: "Leasing & PMS",
    description: "Normalize inquiries, showings, rental applications, leases, tenants, and ledgers.",
    authMode: "credentials",
    permissions: ["Rental applications", "Showings", "Tenants", "Tenant ledgers"],
    credentialFields: [
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "database", label: "Database name" },
    ],
    env: [],
    webhook: false,
    note: "Availability depends on the AppFolio Stack partnership and the customer's enabled API products.",
  },
  {
    id: "buildium",
    title: "Buildium",
    category: "Leasing & PMS",
    description: "Read rentals, applicants, leases, showings, work orders, and general-ledger data.",
    authMode: "credentials",
    permissions: ["Rentals", "Applicants", "Leases", "Tasks", "Accounting"],
    credentialFields: [
      { key: "clientId", label: "Buildium client ID" },
      { key: "clientSecret", label: "Buildium client secret", secret: true },
      { key: "environment", label: "Environment: sandbox or production" },
    ],
    env: [],
    webhook: false,
    note: "Server-to-server authentication using Buildium's required client headers.",
  },
  {
    id: "yardi",
    title: "Yardi Voyager",
    category: "Leasing & PMS",
    description: "Normalize resident, lease, and general-ledger data from Yardi Voyager or Breeze.",
    authMode: "credentials",
    permissions: ["Resident data", "Leases", "General ledger"],
    credentialFields: [
      { key: "interfaceId", label: "Yardi interface ID" },
      { key: "interfaceKey", label: "Yardi interface key", secret: true },
    ],
    env: [],
    webhook: false,
    note: "Requires becoming an approved Yardi Interface Partner and a signed per-interface agreement. No self-serve signup.",
  },
  {
    id: "realpage",
    title: "RealPage",
    category: "Leasing & PMS",
    description: "Normalize leasing, resident, and accounting data from RealPage's enterprise multifamily platform.",
    authMode: "credentials",
    permissions: ["Resident data", "Leases", "Accounting data"],
    credentialFields: [
      { key: "clientId", label: "RealPage Exchange client ID" },
      { key: "clientSecret", label: "RealPage Exchange client secret", secret: true },
    ],
    env: [],
    webhook: false,
    note: "Access is granted only through the RealPage Exchange partner program. Sales-led, not self-serve.",
  },
  {
    id: "entrata",
    title: "Entrata",
    category: "Leasing & PMS",
    description: "Normalize leases, resident profiles, and accounting data from Entrata's multifamily suite.",
    authMode: "credentials",
    permissions: ["Leases", "Resident profiles", "Accounting data"],
    credentialFields: [
      { key: "apiUser", label: "Entrata API user" },
      { key: "apiPassword", label: "Entrata API password", secret: true },
    ],
    env: [],
    webhook: false,
    note: "Requires a signed API Developer Interface Agreement and IP allowlisting before any credential works.",
  },
  {
    id: "rentmanager",
    title: "Rent Manager",
    category: "Leasing & PMS",
    description: "Normalize rentals, tenants, work orders, and accounting data from Rent Manager.",
    authMode: "credentials",
    permissions: ["Rentals", "Tenants", "Work orders", "Accounting"],
    credentialFields: [{ key: "apiKey", label: "Rent Manager API key", secret: true }],
    env: [],
    webhook: false,
    note: "Requires enrollment in Rent Manager's Integrations Program rather than a public self-serve key.",
  },
  {
    id: "doorloop",
    title: "DoorLoop",
    category: "Leasing & PMS",
    description: "Normalize rentals, leases, tenants, and accounting data from DoorLoop.",
    authMode: "api_key",
    permissions: ["Rentals", "Leases", "Tenants", "Accounting"],
    credentialFields: [{ key: "apiKey", label: "DoorLoop API key", secret: true }],
    env: [],
    webhook: false,
    note: "Public, self-serve API key generated directly in DoorLoop account settings.",
  },
  {
    id: "generic_email",
    title: "Other PMS (email notifications)",
    category: "Leasing & PMS",
    description: "Capture work orders, messages and notices from any PMS that can copy an address on outbound mail.",
    authMode: "credentials",
    permissions: ["Inbound notifications"],
    credentialFields: [{ key: "pmsName", label: "Which system sends these notifications?" }],
    env: [],
    webhook: true,
    note:
      "The universal fallback: no API and no partnership needed. Inbound only, and unverified mail is stored "
      + "without being parsed — anyone can send to a seat address claiming to be a PMS.",
  },
  {
    id: "whatsapp",
    title: "WhatsApp Business",
    category: "Communication",
    description: "Receive tenant messages and send approved replies through Meta's Cloud API.",
    authMode: "credentials",
    permissions: ["whatsapp_business_messaging", "whatsapp_business_management"],
    credentialFields: [
      { key: "businessAccountId", label: "WhatsApp Business Account ID" },
      { key: "phoneNumberId", label: "Phone number ID" },
      { key: "accessToken", label: "Permanent system-user access token", secret: true },
    ],
    env: ["META_WHATSAPP_APP_SECRET", "META_WHATSAPP_VERIFY_TOKEN", "META_GRAPH_API_VERSION"],
    webhook: true,
    readOnly: false,
    note: "Inbound events are signature-verified before they enter the message queue.",
  },
  {
    id: "whatsapp_personal",
    title: "WhatsApp (Personal)",
    category: "Communication",
    description: "Send and receive tenant messages from a personal WhatsApp number, for teams without a Business account.",
    authMode: "qr_link",
    permissions: ["Messages"],
    env: [],
    webhook: true,
    readOnly: false,
    note: "Links via a QR-paired companion device, the same mechanism as WhatsApp Web. Less reliable than the official Business API and outside WhatsApp's own terms for automated use.",
  },
  {
    id: "apple_messages",
    title: "Apple Messages",
    category: "Communication",
    description: "Route Apple Messages for Business conversations through an approved messaging provider.",
    authMode: "msp",
    permissions: ["Business registration", "Messaging Service Provider routing"],
    credentialFields: [
      { key: "provider", label: "Messaging Service Provider" },
      { key: "webhookSecret", label: "Webhook signing secret", secret: true },
    ],
    env: [],
    webhook: true,
    readOnly: false,
    note: "Apple does not offer direct iMessage OAuth. This adapter requires Apple approval and an MSP.",
  },
  {
    id: "slack",
    title: "Slack",
    category: "Communication",
    description: "Read selected channels, route approvals, and post task updates.",
    authMode: "oauth2",
    permissions: ["channels:history", "channels:read", "chat:write", "users:read"],
    env: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"],
    webhook: true,
    readOnly: false,
    note: "Workspace admins choose channels during OAuth; events are acknowledged before processing.",
  },
  {
    id: "notion",
    title: "Notion",
    category: "Knowledge",
    description: "Index only the pages and databases explicitly shared with Aval.",
    authMode: "oauth2",
    permissions: ["User-selected pages and databases"],
    env: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
    webhook: false,
    readOnly: true,
    note: "Notion's authorization screen controls the exact workspace content Aval can access.",
  },
  {
    id: "outlook",
    title: "Outlook",
    category: "Communication",
    description: "Read selected mail and calendar context through Microsoft Graph.",
    authMode: "oauth2",
    permissions: ["offline_access", "User.Read", "Mail.Read", "Mail.Send", "Calendars.Read"],
    env: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    webhook: false,
    readOnly: false,
    note: "Delegated Microsoft Graph access; no mailbox-wide app permission is requested.",
  },
  {
    id: "gmail",
    title: "Gmail",
    category: "Communication",
    description: "Read property operations email and thread it into the shared inbox.",
    authMode: "oauth2",
    permissions: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    webhook: false,
    readOnly: false,
    note: "Google OAuth for reading messages and sending approved replies.",
  },
  {
    id: "telegram",
    title: "Telegram",
    category: "Communication",
    description: "Connect a Telegram bot for tenant and contractor conversations.",
    authMode: "bot_token",
    permissions: ["Bot messages", "Webhook updates"],
    credentialFields: [
      { key: "botToken", label: "Bot token", secret: true },
      { key: "webhookSecret", label: "Webhook secret", secret: true },
    ],
    env: [],
    webhook: true,
    readOnly: false,
    note: "Webhook requests must include Telegram's configured secret-token header.",
  },
  {
    id: "twilio",
    title: "Calls & SMS",
    category: "Communication",
    description: "Place, receive, transcribe, and attach calls or SMS to the resident record.",
    authMode: "credentials",
    permissions: ["Calls", "Messages", "Recordings"],
    credentialFields: [
      { key: "accountSid", label: "Account SID" },
      { key: "authToken", label: "Auth token", secret: true },
    ],
    env: [],
    webhook: true,
    readOnly: false,
    note: "Designed for Twilio-compatible telephony; webhook signatures are required.",
  },
  {
    id: "granola",
    title: "Granola",
    category: "Knowledge",
    description: "Bring meeting notes and follow-ups into property and vendor timelines.",
    authMode: "api_key",
    permissions: ["Meeting notes", "Transcripts", "Participants"],
    credentialFields: [{ key: "apiKey", label: "Granola Business API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Uses Granola's public API; its MCP OAuth route can be added for agent-to-agent access.",
  },
  {
    id: "openai",
    title: "OpenAI",
    category: "Model",
    description: "Power agents and Ask Aval with your own OpenAI account.",
    authMode: "api_key",
    permissions: ["Model calls (Chat Completions API)"],
    credentialFields: [{ key: "apiKey", label: "OpenAI API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Uses OpenAI's Chat Completions API with function calling.",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-6-luna",
  },
  {
    id: "google_gemini",
    title: "Google Gemini",
    category: "Model",
    description: "Power agents and Ask Aval with your own Google AI Studio / Gemini API key.",
    authMode: "api_key",
    permissions: ["Model calls (Gemini API, OpenAI-compatible endpoint)"],
    credentialFields: [{ key: "apiKey", label: "Gemini API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Calls Gemini's OpenAI-compatibility endpoint, so the same tool-calling loop works unchanged.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-pro",
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    category: "Model",
    description: "Route agents and Ask Aval through any model OpenRouter offers, billed to your OpenRouter account.",
    authMode: "api_key",
    permissions: ["Model calls (OpenAI-compatible API)"],
    credentialFields: [{ key: "apiKey", label: "OpenRouter API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "One key, many underlying models — pick the exact model id in Advanced once connected.",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.5",
  },
  {
    id: "moonshot",
    title: "Moonshot AI",
    category: "Model",
    description: "Power agents and Ask Aval with your own Moonshot AI (Kimi) account.",
    authMode: "api_key",
    permissions: ["Model calls (OpenAI-compatible API)"],
    credentialFields: [{ key: "apiKey", label: "Moonshot API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Uses Moonshot's OpenAI-compatible endpoint.",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2-turbo-preview",
  },
  {
    id: "zai",
    title: "Z.AI",
    category: "Model",
    description: "Power agents and Ask Aval with your own Z.AI (GLM) account.",
    authMode: "api_key",
    permissions: ["Model calls (OpenAI-compatible API)"],
    credentialFields: [{ key: "apiKey", label: "Z.AI API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Uses Z.AI's OpenAI-compatible endpoint.",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-4.6",
  },
  {
    id: "deepseek",
    title: "DeepSeek",
    category: "Model",
    description: "Power agents and Ask Aval with your own DeepSeek account.",
    authMode: "api_key",
    permissions: ["Model calls (OpenAI-compatible API)"],
    credentialFields: [{ key: "apiKey", label: "DeepSeek API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Uses DeepSeek's OpenAI-compatible endpoint.",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
  },
  {
    id: "alibaba_model_studio",
    title: "Alibaba Cloud Model Studio",
    category: "Model",
    description: "Power agents and Ask Aval with your own Alibaba Cloud Model Studio (DashScope / Qwen) account.",
    authMode: "api_key",
    permissions: ["Model calls (OpenAI-compatible API)"],
    credentialFields: [{ key: "apiKey", label: "DashScope API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Uses DashScope's OpenAI-compatible endpoint. If a key returns region errors, the account may need the China (Beijing) endpoint instead of International — contact Aval support to switch it.",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-max",
  },
  {
    id: "siliconflow",
    title: "SiliconFlow",
    category: "Model",
    description: "Power agents and Ask Aval with your own SiliconFlow account.",
    authMode: "api_key",
    permissions: ["Model calls (OpenAI-compatible API)"],
    credentialFields: [{ key: "apiKey", label: "SiliconFlow API key", secret: true }],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Uses SiliconFlow's OpenAI-compatible endpoint.",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
  },
  {
    id: "claude",
    title: "Claude Pro / Max",
    category: "Model",
    description: "Connect your Claude Pro or Max subscription instead of pasting a separate API key.",
    authMode: "oauth_subscription_paste",
    permissions: ["Model calls billed to your Claude subscription"],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Uses the same OAuth client Claude Code uses. Aval never sees your Anthropic password — only a subscription access token you authorize, which you can revoke anytime from your Anthropic account.",
  },
  {
    id: "chatgpt",
    title: "ChatGPT Plus / Pro",
    category: "Model",
    description: "Connect your ChatGPT Plus or Pro subscription instead of pasting a separate API key.",
    authMode: "oauth_subscription_paste",
    permissions: ["Model calls billed to your ChatGPT subscription, via the Codex backend"],
    env: [],
    webhook: false,
    readOnly: true,
    note: "Uses the same OAuth client the Codex CLI uses. Aval never sees your OpenAI password — only a subscription access token you authorize, which you can revoke anytime from your OpenAI account.",
    subscriptionOf: "openai",
  },
];

export function getProvider(id: string) {
  return integrationCatalog.find((provider) => provider.id === id);
}

export function configuredEnvironment(provider: IntegrationProvider, bindings: Record<string, unknown>) {
  return !provider.setupBlocker && (provider.env.length === 0 || provider.env.every((key) => typeof bindings[key] === "string" && String(bindings[key]).trim().length > 0));
}
