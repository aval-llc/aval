"use client";

import { Database } from "iconoir-react";
import { siAsana, siBox, siGooglechat, siGoogledrive, siGooglesheets, siMeta, siAlibabacloud, siAnthropic, siApple, siDeepseek, siGmail, siGooglegemini, siMoonshotai, siNotion, siOpenrouter, siQuickbooks, siTelegram, siWhatsapp, siXero } from "simple-icons";

function SimpleMark({ icon }: { icon: { path: string; hex: string; title: string } }) { return <svg viewBox="0 0 24 24" aria-label={icon.title} role="img"><path fill={`#${icon.hex}`} d={icon.path}/></svg>; }
function SlackMark() { return <svg viewBox="0 0 24 24" aria-label="Slack" role="img"><path fill="#36C5F0" d="M5.2 0a2.4 2.4 0 0 0 0 4.8h2.4V2.4A2.4 2.4 0 0 0 5.2 0m0 6.4H2.4a2.4 2.4 0 0 0 0 4.8h2.8z"/><path fill="#2EB67D" d="M24 5.2a2.4 2.4 0 0 0-4.8 0v2.4h2.4A2.4 2.4 0 0 0 24 5.2m-6.4 0V2.4a2.4 2.4 0 0 0-4.8 0v2.8z"/><path fill="#ECB22E" d="M18.8 24a2.4 2.4 0 0 0 0-4.8h-2.4v2.4a2.4 2.4 0 0 0 2.4 2.4m0-6.4h2.8a2.4 2.4 0 0 0 0-4.8h-2.8z"/><path fill="#E01E5A" d="M0 18.8a2.4 2.4 0 0 0 4.8 0v-2.4H2.4A2.4 2.4 0 0 0 0 18.8m6.4 0v2.8a2.4 2.4 0 0 0 4.8 0v-2.8z"/></svg>; }
function OutlookMark() { return <svg viewBox="0 0 24 24" aria-label="Microsoft Outlook" role="img"><path fill="#0A64C9" d="M1 4.8 11.1 3v18L1 19.2z"/><path fill="#1976D2" d="M12.3 5h10.3v14H12.3z"/><path fill="#fff" d="M12.3 8.3h10.3v1.2l-5.1 3.9-5.2-3.9zM4 8h4.2c2.3 0 3.6 1.6 3.6 4s-1.3 4-3.7 4H4zm2.2 1.8v4.4h1.7c1.1 0 1.7-.8 1.7-2.2s-.6-2.2-1.7-2.2z"/></svg>; }
/** OpenAI's knot mark. Drawn inline because simple-icons no longer ships it, and a text wordmark in a box reads as a placeholder next to real logos. */
function OpenAiMark() { return <svg viewBox="0 0 24 24" aria-label="OpenAI" role="img"><path fill="currentColor" d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .75 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.05 6.05 0 0 0 5.77-4.19 5.98 5.98 0 0 0 4-2.9 6.05 6.05 0 0 0-.75-7.09m-9.02 12.6a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.79.79 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.06v5.58a4.5 4.5 0 0 1-4.5 4.49M3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.09 4.79 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.07l-4.84 2.79a4.5 4.5 0 0 1-6.14-1.64M2.34 7.9a4.49 4.49 0 0 1 2.35-1.97V11.6a.77.77 0 0 0 .38.68l5.82 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.8a4.5 4.5 0 0 1-1.63-6.14zm16.6 3.86-5.83-3.39L15.12 7.2a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.66a.79.79 0 0 0-.39-.68zm2.01-3.02-.14-.09-4.78-2.79a.78.78 0 0 0-.79 0L9.4 9.23V6.9a.07.07 0 0 1 .03-.07l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.3 12.86 6.28 11.7a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.37-3.45l-.14.08L8.69 5.46a.79.79 0 0 0-.39.68zm1.1-2.36 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5z"/></svg>; }

function TwilioMark() { return <svg viewBox="0 0 24 24" aria-label="Twilio" role="img"><circle cx="12" cy="12" r="10" fill="#F22F46"/><g fill="#fff"><circle cx="8.6" cy="8.6" r="2.1"/><circle cx="15.4" cy="8.6" r="2.1"/><circle cx="8.6" cy="15.4" r="2.1"/><circle cx="15.4" cy="15.4" r="2.1"/></g></svg>; }

/**
 * Providers whose real mark ships as a file.
 *
 * These are the ones `simple-icons` does not carry — it only covers brands
 * above a popularity threshold, which most property-management software sits
 * under. Each file is the vendor's own current icon asset, kept local rather
 * than hotlinked so the marks survive offline, cannot break when a vendor
 * reorganizes its CDN, and need no CSP exception.
 *
 */
export const PROVIDER_ASSETS: Readonly<Record<string, string>> = {
  yardi: "/brand/providers/yardi.png",
  zoopla: "/brand/providers/zoopla.png",
  onedrive: "/brand/providers/onedrive.svg",
  sme_professional: "/brand/providers/sme_professional.png",
  tenantcloud: "/brand/providers/tenantcloud.png",
  "yardi_breeze": "/brand/providers/yardi_breeze.png",
  "reapit": "/brand/providers/reapit.png",
  "10ninety": "/brand/providers/10ninety.png",
  "arthur": "/brand/providers/arthur.png",
  "joblogic": "/brand/providers/joblogic.png",
  "rentvine": "/brand/providers/rentvine.png",
  "buildingstack": "/brand/providers/buildingstack.png",
  "gohighlevel": "/brand/providers/gohighlevel.png",
  "igloohome": "/brand/providers/igloohome.png",
  "propstack": "/brand/providers/propstack.png",
  "resharmonics": "/brand/providers/resharmonics.png",
  "realpad": "/brand/providers/realpad.png",
  "rentvision": "/brand/providers/rentvision.png",
  "showmojo": "/brand/providers/showmojo.png",
  "street": "/brand/providers/street.png",
  "yardi_kube": "/brand/providers/yardi_kube.png",
  "rightmove": "/brand/providers/rightmove.png",
  "onthemarket": "/brand/providers/onthemarket.png",
  "microsoft_teams": "/brand/providers/microsoft_teams.png",

  appfolio: "/brand/providers/appfolio.png",
  buildium: "/brand/providers/buildium.png",
  realpage: "/brand/providers/realpage.svg",
  entrata: "/brand/providers/entrata.png",
  rentmanager: "/brand/providers/rentmanager.png",
  doorloop: "/brand/providers/doorloop.png",
  granola: "/brand/providers/granola.svg",
  contpaqi: "/brand/providers/contpaqi.png",
  alegra: "/brand/providers/alegra.svg",
  zai: "/brand/providers/zai.svg",
  siliconflow: "/brand/providers/siliconflow.png",
};

/** The same provider-mark rendering used across Connections, Inbox, and Tasks — reused by the automation timeline so real channel icons appear per step instead of generic action icons. */
export function BrandMark({ provider, small = false }: { provider: string; small?: boolean }) {
  provider = ({ imessage: "apple_messages" } as Record<string,string>)[provider] ?? provider;
  const simple = ({ asana: siAsana, box: siBox, google_chat: siGooglechat, google_drive: siGoogledrive, google_sheets: siGooglesheets, meta: siMeta } as Record<string, {path:string;hex:string;title:string}>)[provider];
  if (simple) return <span className={`brand-mark ${small ? "small" : ""} brand-${provider}`}><SimpleMark icon={simple}/></span>;
  const initials = ({ peach: "P", rm_cloud: "RM", sme_professional: "SME", tenantcloud: "TC", zoopla: "Z", onedrive: "OD" } as Record<string,string>)[provider];
  const asset = PROVIDER_ASSETS[provider];
  if (asset) {
    return <span className={`brand-mark ${small ? "small" : ""} brand-${provider}`}><img className="provider-logo" src={asset} alt="" aria-hidden="true"/></span>;
  }
  const inner = provider === "whatsapp" ? <SimpleMark icon={siWhatsapp}/> : provider === "apple_messages" ? <SimpleMark icon={siApple}/> : provider === "slack" ? <SlackMark/> : provider === "notion" ? <SimpleMark icon={siNotion}/> : provider === "outlook" ? <OutlookMark/> : provider === "gmail" ? <SimpleMark icon={siGmail}/> : provider === "telegram" ? <SimpleMark icon={siTelegram}/> : provider === "twilio" ? <TwilioMark/> : provider === "quickbooks" ? <SimpleMark icon={siQuickbooks}/> : provider === "xero" ? <SimpleMark icon={siXero}/> : provider === "yardi" ? <span className="wordmark yardi-mark">Y</span> : provider === "whatsapp_personal" ? <SimpleMark icon={siWhatsapp}/> : provider === "aval" ? <img src="/brand/aval-mark.png" alt="Aval" /> : provider === "claude" ? <SimpleMark icon={siAnthropic}/> : provider === "openai" || provider === "chatgpt" ? <OpenAiMark/> : provider === "google_gemini" ? <SimpleMark icon={siGooglegemini}/> : provider === "openrouter" ? <SimpleMark icon={siOpenrouter}/> : provider === "moonshot" ? <SimpleMark icon={siMoonshotai}/> : provider === "deepseek" ? <SimpleMark icon={siDeepseek}/> : provider === "alibaba_model_studio" ? <SimpleMark icon={siAlibabacloud}/> : initials ? <span className="wordmark" aria-label={provider.replaceAll("_", " ")}>{initials}</span> : <Database width={22} height={22}/>;
  return <span className={`brand-mark ${small ? "small" : ""} brand-${provider}`}>{inner}</span>;
}
