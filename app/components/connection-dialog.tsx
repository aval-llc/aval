"use client";

import { IntegrationSyncControls } from "./integration-sync-controls";
import { connectionBlocker } from "@/lib/integrations/readiness";
import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslations } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { Check, Key, NavArrowRight, NetworkLeft, ShieldCheck, User, Xmark } from "iconoir-react";
import { useExperience } from "@/app/components/experience";
import { BrandMark } from "@/app/components/brand-mark";
import { Foldout } from "@/app/components/foldout";
import { REASONING_EFFORT_LEVELS, modelOptionsFor, supportsReasoningEffort } from "@/lib/integrations/model-providers";
import { providerIsReadOnly } from "@/lib/pms/derive.ts";

/**
 * Shared by the Connections page (dashboard-client.tsx) and Settings →
 * Intelligence (intelligence-settings.tsx) — a model provider is just an
 * IntegrationProvider with category "Model" (lib/integrations/catalog.ts),
 * so the same connect/verify dialog works unchanged for both.
 */
export type Provider = {
  id: string; title: string; category: string; description: string; authMode: string;
  permissions: string[]; credentialFields?: { key: string; label: string; secret?: boolean }[];
  env: string[]; webhook: boolean; readOnly?: boolean; note: string; configured?: boolean;
  connection?: { id?: string; status: string; externalAccountName?: string | null; lastSyncAt?: string | null } | null;
  /** Model providers only (category "Model") — the catalog's suggested model id, shown as a placeholder for the Advanced override field below. */
  defaultModel?: string;
  setupBlocker?: string;
  readiness?: { sync: boolean; verification: boolean };
  /** Subscription providers only (authMode "oauth_subscription_paste") — the API-key provider this one is an alternative to; intelligence-settings.tsx folds it into that provider's own row instead of listing it separately. */
  subscriptionOf?: string;
};

const guides: Record<string, { aval: string[]; customer: string[]; proof: string }> = {
  quickbooks: { aval: ["Intuit production app, callback URL, and accounting scope", "Encrypted refresh-token rotation", "Webhook handling for changed entities"], customer: ["QuickBooks Online administrator", "Select the correct company during consent", "Approve a read-only data check"], proof: "OAuth must return and store the selected company realm." },
  xero: { aval: ["Xero OAuth app and exact callback URL", "2026 granular read scopes plus offline_access", "Tenant-aware sync"], customer: ["Standard or adviser role", "Choose the correct Xero organisation", "Confirm invoices, payments, bank transactions, and reports"], proof: "Aval must store the selected tenant ID." },
  appfolio: { aval: ["Approved AppFolio Stack partnership", "Contracted API products", "Database-to-portfolio field map"], customer: ["Ask AppFolio to enable agreed API products", "Provide database and issued credentials", "Approve a historical sync window"], proof: "Credentials cannot work until AppFolio enables each product." },
  buildium: { aval: ["Buildium client-header adapter", "Ten-concurrent-request limit", "Pagination and source-ID checkpoints"], customer: ["Buildium API subscription", "Client ID and secret", "Confirm rentals, applicants, leases, tasks, and accounting"], proof: "Aval calls the official rentals endpoint before marking connected." },
  yardi: { aval: ["Approved Yardi Interface Partner status", "Per-interface licensing agreement", "Voyager/Breeze field mapping"], customer: ["Yardi property management agreement", "Interface enabled by your Yardi account team", "Approve a historical sync window"], proof: "Credentials cannot work until Yardi's partner team issues an interface." },
  realpage: { aval: ["RealPage Exchange partner enrollment", "AppPartner integration agreement", "Field mapping to Aval's internal model"], customer: ["RealPage account team introduction", "RealPage Exchange access request", "Approve a historical sync window"], proof: "Aval calls the RealPage Exchange endpoint before marking connected." },
  entrata: { aval: ["Signed API Developer Interface Agreement", "IP allowlisting", "Entrata field mapping"], customer: ["Entrata administrator", "Request API access from Entrata support", "Provide the IP ranges to allowlist"], proof: "Entrata rejects calls from outside the agreed IP range until this is complete." },
  rentmanager: { aval: ["Rent Manager Integrations Program enrollment", "API key adapter", "Field mapping to Aval's internal model"], customer: ["Rent Manager account", "Enroll in the Integrations Program", "Issue an API key to Aval"], proof: "Aval calls the Rent Manager API before marking connected." },
  doorloop: { aval: ["Public API adapter", "Rate-limit aware sync", "Field mapping to Aval's internal model"], customer: ["DoorLoop account", "Generate an API key in Settings", "Confirm rentals, leases, tenants, and accounting"], proof: "Aval calls the DoorLoop API before marking connected." },
  whatsapp: { aval: ["Meta app, Graph version, app secret, verify token", "Signed HTTPS webhook", "Approved outbound message templates"], customer: ["Verified Meta Business portfolio", "Registered WhatsApp number", "Permanent system-user token, WABA ID, and Phone Number ID"], proof: "Aval reads the phone-number record before accepting signed events." },
  whatsapp_personal: { aval: ["Linked-device session manager", "QR refresh and reconnect handling", "Rate-limit aware send queue"], customer: ["A phone with WhatsApp installed", "Scan the QR code Aval shows you", "Keep that phone connected to the internet"], proof: "Aval confirms the linked session is active before marking this connected, the same handshake WhatsApp Web uses." },
  apple_messages: { aval: ["Messages for Business approval", "Apple-approved Messaging Service Provider", "MSP webhook/send adapter"], customer: ["Register the brand and entry points", "Choose an approved MSP", "Complete Apple/MSP launch review"], proof: "There is no direct consumer iMessage API or OAuth shortcut." },
  slack: { aval: ["Slack app, redirect, event subscriptions, signing secret", "Least-privilege bot scopes", "Fast acknowledgement and async event processing"], customer: ["Workspace administrator", "Choose workspace and channels", "Invite the bot to private channels"], proof: "OAuth identifies the workspace; signed events prove origin." },
  notion: { aval: ["Public Notion integration and redirect", "Encrypted credentials", "Page-level sync cursor"], customer: ["Authorised workspace member", "Choose pages in Notion's page picker", "Share additional pages later"], proof: "Aval sees only explicitly selected content." },
  outlook: { aval: ["Microsoft Entra app and redirect", "Delegated Mail.Read and Calendars.Read", "Optional renewable Graph subscriptions"], customer: ["Microsoft 365 account", "Tenant consent if policy requires", "Choose the operational mailbox/calendar"], proof: "No app-wide mailbox permission is requested." },
  gmail: { aval: ["Verified Google OAuth consent screen", "Restricted-scope verification/security review", "Pub/Sub and renewable users.watch for push"], customer: ["Google Workspace account", "Admin approval if apps are restricted", "Choose the operational mailbox"], proof: "OAuth verifies the mailbox connection. Automatic history import is not available yet." },
  telegram: { aval: ["HTTPS webhook and secret-token validation", "Update normalization", "Outbound rate handling"], customer: ["Create a bot with BotFather", "Copy token and generate webhook secret", "Add bot to the required chats"], proof: "Aval calls getMe, then installs a verified webhook." },
  twilio: { aval: ["Official webhook-signature validation", "Voice/SMS event mapping", "Recording consent policy"], customer: ["Twilio account and number", "Account SID and auth token", "Point voice/message webhooks to Aval"], proof: "Aval fetches the upstream Twilio account first." },
  granola: { aval: ["Public API adapter", "Scoped note ingestion", "Separate optional MCP flow"], customer: ["Granola Business workspace", "Workspace API key with note scopes", "Choose personal/public note access"], proof: "The public API check is distinct from Granola MCP browser OAuth." },
  anthropic: { aval: ["Anthropic Messages API adapter", "Encrypted key storage", "Same guarded agent loop as every model provider"], customer: ["An Anthropic account", "An API key with billing enabled", "Choose the exact model in Advanced"], proof: "Aval lists your account's available models before marking this connected." },
  openai: { aval: ["Chat Completions adapter with function calling", "Encrypted key storage", "Same tool-calling loop and faithfulness gate as every other model"], customer: ["An OpenAI account", "An API key with billing enabled", "Choose the exact model in Advanced"], proof: "Aval lists your account's available models before marking this connected." },
  google_gemini: { aval: ["Gemini's OpenAI-compatible endpoint", "Encrypted key storage", "Same tool-calling loop and faithfulness gate as every other model"], customer: ["A Google AI Studio account", "A Gemini API key", "Choose the exact model in Advanced"], proof: "Aval lists your account's available models before marking this connected." },
  openrouter: { aval: ["OpenRouter's OpenAI-compatible endpoint", "Encrypted key storage", "Any underlying model OpenRouter offers"], customer: ["An OpenRouter account with credit", "An API key", "Choose the exact model id in Advanced"], proof: "Aval lists your account's available models before marking this connected." },
  moonshot: { aval: ["Moonshot's OpenAI-compatible endpoint", "Encrypted key storage", "Same tool-calling loop and faithfulness gate as every other model"], customer: ["A Moonshot AI account", "An API key with billing enabled", "Choose the exact model in Advanced"], proof: "Aval lists your account's available models before marking this connected." },
  zai: { aval: ["Z.AI's OpenAI-compatible endpoint", "Encrypted key storage", "Same tool-calling loop and faithfulness gate as every other model"], customer: ["A Z.AI account", "An API key with billing enabled", "Choose the exact model in Advanced"], proof: "Aval lists your account's available models before marking this connected." },
  deepseek: { aval: ["DeepSeek's OpenAI-compatible endpoint", "Encrypted key storage", "Same tool-calling loop and faithfulness gate as every other model"], customer: ["A DeepSeek account", "An API key with billing enabled", "Choose the exact model in Advanced"], proof: "Aval lists your account's available models before marking this connected." },
  alibaba_model_studio: { aval: ["DashScope's OpenAI-compatible endpoint", "Encrypted key storage", "Same tool-calling loop and faithfulness gate as every other model"], customer: ["An Alibaba Cloud Model Studio account", "A DashScope API key", "Choose the exact model in Advanced"], proof: "Aval lists your account's available models before marking this connected." },
  siliconflow: { aval: ["SiliconFlow's OpenAI-compatible endpoint", "Encrypted key storage", "Same tool-calling loop and faithfulness gate as every other model"], customer: ["A SiliconFlow account", "An API key with billing enabled", "Choose the exact model in Advanced"], proof: "Aval lists your account's available models before marking this connected." },
};

// A stylized, deterministic QR-like pattern for the WhatsApp Personal linking
// flow — decorative only (no real pairing session exists in sample mode),
// not a scannable code. Generated once with a seeded PRNG so it's stable
// across renders instead of reshuffling on every re-render.
const QR_DATA_CELLS: [number, number][] = (() => {
  const size = 29;
  const inFinderZone = (x: number, y: number) => (x < 8 && y < 8) || (x >= 21 && y < 8) || (x < 8 && y >= 21);
  const cells: [number, number][] = [];
  let seed = 42;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inFinderZone(x, y)) continue;
      if (next() < 0.42) cells.push([x, y]);
    }
  }
  return cells;
})();

function QrPlaceholder() {
  return (
    <svg viewBox="0 0 29 29" className="qr-placeholder" role="img" aria-hidden="true">
      <rect width="29" height="29" fill="white"/>
      {([[0, 0], [22, 0], [0, 22]] as const).map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <rect x={x} y={y} width="7" height="7" fill="black"/>
          <rect x={x + 1} y={y + 1} width="5" height="5" fill="white"/>
          <rect x={x + 2} y={y + 2} width="3" height="3" fill="black"/>
        </g>
      ))}
      {QR_DATA_CELLS.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="black"/>)}
    </svg>
  );
}

export function ConnectionDialog({ provider, onClose, onRefresh }: { provider: Provider | null; onClose: () => void; onRefresh: () => void }) {
  const { celebrate, notify } = useExperience();
  const t = useTranslations(); const [credentials, setCredentials] = useState<Record<string, string>>({}); const [status, setStatus] = useState<"idle" | "working" | "error" | "saved">("idle"); const [message, setMessage] = useState("");
  if (!provider) return null; const providerGuide = provider.id === "sap_bydesign" ? { aval: [t("ConnectionDialog.sap.adapter"), t("ConnectionDialog.sap.storage")], customer: [t("ConnectionDialog.sap.admin"), t("ConnectionDialog.sap.fields")], proof: t("ConnectionDialog.sap.proof") } : guides[provider.id] ?? { aval: ["Secure provider adapter"], customer: ["Administrator consent"], proof: "The upstream identity is verified before sync." }; const blocker = provider.setupBlocker ?? connectionBlocker(provider.id); const blocked = Boolean(blocker) || provider.configured === false;
  const connect = async (event?: FormEvent) => {
    event?.preventDefault();
    if (blocked || status === "working") return;
    setStatus("working"); setMessage("");
    try {
      const response = await fetch("/api/integrations/connect", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, credentials: provider.authMode === "oauth2" ? undefined : credentials, returnTo: `${window.location.pathname}?view=connections` }),
      });
      const data = await response.json() as { authorizationUrl?: string; error?: string; required?: string[]; missing?: string[]; connection?: { id: string } };
      if (!response.ok) throw new Error(`${data.error ?? t("ConnectionDialog.connectionFailed")}${data.missing ? `: ${data.missing.join(", ")}` : ""}`);
      if (data.authorizationUrl) { window.location.assign(data.authorizationUrl); return; }
      if (!data.connection?.id) throw new Error(t("ConnectionDialog.connectionFailed"));
      const verification = await fetch("/api/integrations/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: data.connection.id }) });
      const verified = await verification.json() as { error?: string; connection?: { externalAccountName?: string } };
      if (!verification.ok) {
        setStatus("error");
        setMessage(`${t("ConnectionDialog.credentialsEncryptedProviderActionRemains")} ${verified.error ?? provider.note}`);
        notify(t("ConnectionDialog.setupSaved"), provider.title); onRefresh(); return;
      }
      setCredentials({}); setStatus("saved");
      setMessage(t(provider.id === "sap_bydesign" ? "ConnectionDialog.sap.verified" : provider.category === "Model" ? "ConnectionDialog.connectionVerified" : "ConnectionDialog.identityVerifiedInitialSyncIsQueued"));
      celebrate(t("ConnectionDialog.connectionVerified"), verified.connection?.externalAccountName ?? provider.title);
      onRefresh();
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : t("ConnectionDialog.connectionFailed")); }
  };
  const validate = async () => {
    if (!provider.connection?.id || status === "working") return;
    setStatus("working"); setMessage("");
    try {
      const response = await fetch("/api/integrations/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: provider.connection.id }), signal: AbortSignal.timeout(60000) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? t("ConnectionDialog.connectionFailed"));
      setStatus("idle"); setMessage(t("ConnectionDialog.accessValidated")); onRefresh();
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : t("ConnectionDialog.connectionFailed")); }
  };
  return <Dialog.Root open onOpenChange={(open) => !open && onClose()}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="connection-dialog"><div className="dialog-top"><BrandMark provider={provider.id}/><Dialog.Close className="icon-button"><Xmark width={20} height={20}/></Dialog.Close></div><Dialog.Title>{provider.title}</Dialog.Title><Dialog.Description>{provider.id === "sap_bydesign" ? t("ConnectionDialog.sap.description") : provider.description}</Dialog.Description><div className="dialog-status-row"><span><ShieldCheck width={16} height={16}/>{providerIsReadOnly(provider.id, provider.readOnly) ? t("ConnectionDialog.readAccess") : t("ConnectionDialog.twoWayChannel")}</span><span><Key width={16} height={16}/>{provider.authMode.replace("_", " ")}</span><span><NetworkLeft width={16} height={16}/>{provider.webhook ? t("ConnectionDialog.webhookEvents") : t("ConnectionDialog.accessVerification")}</span></div><Tabs.Root defaultValue="readiness"><Tabs.List className="dialog-tabs three"><Tabs.Trigger value="readiness">{t("ConnectionDialog.readiness")}</Tabs.Trigger><Tabs.Trigger value="access">{t("ConnectionDialog.access")}</Tabs.Trigger><Tabs.Trigger value="flow">{t("ConnectionDialog.flow")}</Tabs.Trigger></Tabs.List><Tabs.Content value="readiness"><div className="readiness-grid"><div><p>{t("ConnectionDialog.avalConfiguresOnce")}</p>{providerGuide.aval.map((item) => <span key={item}><Check width={15} height={15}/>{item}</span>)}</div><div><p>{t("ConnectionDialog.customerBrings")}</p>{providerGuide.customer.map((item) => <span key={item}><User width={15} height={15}/>{item}</span>)}</div></div><p className="proof-note"><ShieldCheck width={16} height={16}/>{providerGuide.proof}</p>{blocked && <div className="setup-warning"><strong>{t("ConnectionDialog.notYetAvailableTitle")}</strong><p>{blocker ? t("ConnectionDialog.adapterUnavailableBody") : t("ConnectionDialog.notYetAvailableBody")}</p><Foldout summary={t("ConnectionDialog.technicalReferenceForSupport")}><span>{blocker ?? provider.env.join(" · ")}</span></Foldout></div>}</Tabs.Content><Tabs.Content value="access"><div className="permission-box"><p>{t("ConnectionDialog.avalWillRequest")}</p>{provider.permissions.map((permission) => <span key={permission}><Check width={16} height={16}/>{permission}</span>)}</div><p className="connection-note">{provider.id === "sap_bydesign" ? t("ConnectionDialog.sap.note") : provider.note}</p></Tabs.Content><Tabs.Content value="flow"><ol className="architecture-list"><li><b>01</b><span><strong>{t("ConnectionDialog.authorize")}</strong>{t("ConnectionDialog.consentIsScopedToThisWorkspace")}</span></li><li><b>02</b><span><strong>{t("ConnectionDialog.verify")}</strong>{t("ConnectionDialog.avalTestsTheActualUpstreamIdentity")}</span></li><li><b>03</b><span><strong>{t("ConnectionDialog.normalize")}</strong>{t("ConnectionDialog.sourceIdsAndTimestampsRemainTraceable")}</span></li></ol></Tabs.Content></Tabs.Root>{!blocked && provider.authMode === "qr_link" && <div className="qr-link-panel"><QrPlaceholder/><div><p>{t("ConnectionDialog.qrLinkInstructions")}</p><span className="qr-link-status"><span className="presence-dot"/>{status === "working" ? t("ConnectionDialog.waitingForScan") : t("ConnectionDialog.qrLinkReady")}</span></div></div>}{provider.id === "sap_bydesign" && <p className="connection-note">{t("ConnectionDialog.sap.note")}</p>}{!blocked && provider.authMode !== "oauth2" && provider.authMode !== "qr_link" && <form className="credential-form" onSubmit={connect}>{provider.credentialFields?.map((field) => <label key={field.key}>{provider.id === "sap_bydesign" ? t(`ConnectionDialog.sap.labels.${field.key}`) : field.label}<input type={field.secret ? "password" : "text"} value={credentials[field.key] ?? ""} onChange={(event) => setCredentials((current) => ({ ...current, [field.key]: event.target.value }))} autoComplete="off" required/></label>)}{provider.category === "Model" && <Foldout summary={t("ConnectionDialog.advanced")}><label>{t("ConnectionDialog.modelOverrideLabel")}<select className="model-select" value={credentials.model ?? ""} onChange={(event) => setCredentials((current) => ({ ...current, model: event.target.value }))}><option value="">{t("ConnectionDialog.modelRecommended", { model: provider.defaultModel ?? "" })}</option>{modelOptionsFor(provider.id).map((id) => <option key={id} value={id}>{id}</option>)}</select></label>{supportsReasoningEffort(credentials.model || provider.defaultModel || "") && <label>{t("ConnectionDialog.reasoningEffortLabel")}<select className="model-select" value={credentials.reasoningEffort ?? ""} onChange={(event) => setCredentials((current) => ({ ...current, reasoningEffort: event.target.value }))}><option value="">{t("ConnectionDialog.reasoningEffortDefault")}</option>{REASONING_EFFORT_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>}<p className="foldout-hint">{t("ConnectionDialog.modelOverrideHint")}</p></Foldout>}</form>}{provider.id === "quickbooks" && provider.connection?.status === "connected" && <IntegrationSyncControls provider={provider.id}/>}{message && <p className={`dialog-message ${status}`}>{message}</p>}<div className="dialog-actions">{provider.connection?.status === "connected" && provider.category !== "Model" && !blocked && <button className="soft-button" disabled={status === "working"} onClick={() => void validate()}>{t("ConnectionDialog.validateAccess")}</button>}<button className="soft-button" onClick={onClose}>{t("ConnectionDialog.cancel")}</button><button className="primary-button" disabled={status === "working" || status === "saved" || blocked} onClick={() => connect()}>{status === "working" ? (provider.authMode === "qr_link" ? t("ConnectionDialog.waitingForScan") : t("ConnectionDialog.verifying")) : status === "saved" ? t("ConnectionDialog.saved") : blocked ? t("ConnectionDialog.avalSetupRequired") : provider.authMode === "oauth2" ? t("ConnectionDialog.continueToAuthorization") : provider.authMode === "qr_link" ? t("ConnectionDialog.linkDevice") : provider.id === "sap_bydesign" ? t("ConnectionDialog.sap.test") : t("ConnectionDialog.encryptVerify")}<NavArrowRight width={17} height={17}/></button></div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
