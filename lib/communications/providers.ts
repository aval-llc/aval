import { basicAuth, providerJson, record, requiredString, safeSegment } from "@/lib/integrations/http";
import { isPhone, xml } from "./config";
export const SEND_PROVIDERS = ["slack", "google_chat", "microsoft_teams", "whatsapp", "telegram", "gmail", "outlook", "twilio"] as const;
export type OutboundMessage = { provider: string; to: string; body: string; subject?: string };
export function validateOutbound(input: OutboundMessage) {
  if (!(SEND_PROVIDERS as readonly string[]).includes(input.provider)) throw new Error("This provider does not have a supported message adapter.");
  if (typeof input.to !== 'string' || !input.to.trim() || input.to.length > 500 || /[\r\n]/.test(input.to) || typeof input.body !== 'string' || !input.body.trim() || input.body.length > 4000 || (input.subject !== undefined && (typeof input.subject !== 'string' || input.subject.length > 200 || /[\r\n]/.test(input.subject)))) throw new Error("Enter a destination and a message of at most 4,000 characters.");
  if (["twilio", "whatsapp"].includes(input.provider) && !isPhone(input.to)) throw new Error("The recipient must be an international phone number.");
  if (["gmail", "outlook"].includes(input.provider) && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.to)) throw new Error("Enter one valid recipient email address.");
  if (input.provider === "google_chat" && !/^spaces\/[A-Za-z0-9_-]+$/.test(input.to)) throw new Error("Choose a Google Chat space resource, such as spaces/AAAA.");
}
const encoded = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
export async function dispatchMessage(input: OutboundMessage, credentials: Record<string,string>, config: Record<string,string|undefined>, operationId: string, fromNumber = ""): Promise<{ id: string | null; status: "accepted" }> {
  validateOutbound(input);
  const token = credentials.accessToken ?? credentials.botToken;
  const post = async (url: string, body: unknown, headers: Record<string,string> = { authorization: `Bearer ${token}` }) => record(await providerJson(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  let id: string | null = null;
  if (input.provider === 'slack') id = requiredString((await post('https://slack.com/api/chat.postMessage', { channel: input.to, text: input.body, client_msg_id: operationId, unfurl_links: false, unfurl_media: false })).ts);
  else if (input.provider === 'google_chat') id = requiredString((await post(`https://chat.googleapis.com/v1/${input.to}/messages?requestId=${operationId}`, { text: input.body })).name);
  else if (input.provider === 'microsoft_teams') id = requiredString((await post(`https://graph.microsoft.com/v1.0/chats/${safeSegment(input.to)}/messages`, { body: { contentType: 'text', content: input.body } })).id);
  else if (input.provider === 'telegram') id = requiredString(record((await post(`https://api.telegram.org/bot${credentials.botToken}/sendMessage`, { chat_id: input.to, text: input.body }, {})).result).message_id);
  else if (input.provider === 'whatsapp') {
    const version = config.META_GRAPH_API_VERSION;
    if (!version || !/^v\d+\.\d+$/.test(version)) throw new Error('Configure the Meta Graph API version.');
    const result = await post(`https://graph.facebook.com/${version}/${safeSegment(credentials.phoneNumberId)}/messages`, { messaging_product: 'whatsapp', to: input.to, type: 'text', text: { body: input.body } });
    id = requiredString(record((result.messages as unknown[])?.[0]).id);
  } else if (input.provider === 'gmail') {
    const mime = `To: ${input.to}\r\nSubject: =?UTF-8?B?${encoded(input.subject ?? 'Message from Aval')}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded(input.body)}`;
    id = requiredString((await post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { raw: encoded(mime).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') })).id);
  } else if (input.provider === 'outlook') {
    const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: { subject: input.subject ?? 'Message from Aval', body: { contentType: 'Text', content: input.body }, toRecipients: [{ emailAddress: { address: input.to } }] }, saveToSentItems: true }) });
    await response.body?.cancel();
    if (response.status !== 202) throw new Error(`Microsoft did not accept the message (${response.status}).`);
  } else if (input.provider === 'twilio') {
    if (!isPhone(fromNumber)) throw new Error('Configure your Twilio sending number in Call routing.');
    const callback = config.AVAL_PUBLIC_URL ? new URL('/api/communications/status', config.AVAL_PUBLIC_URL) : null;
    if (callback) callback.searchParams.set('operation', operationId);
    id = requiredString(record(await providerJson(`https://api.twilio.com/2010-04-01/Accounts/${safeSegment(credentials.accountSid)}/Messages.json`, { method: 'POST', headers: { authorization: basicAuth(credentials.accountSid, credentials.authToken), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: input.to, From: fromNumber, Body: input.body, ...(callback ? { StatusCallback: callback.href } : {}) }) })).sid);
  }
  return { id, status: 'accepted' };
}
export async function dispatchCall(to: string, script: string, from: string, credentials: Record<string,string>, callback: string, routeNumber?: string) {
  if (!isPhone(to) || !isPhone(from) || typeof script !== 'string' || !script.trim() || script.length > 1200) throw new Error('A valid recipient, sending number, and short call script are required.');
  if (routeNumber && !isPhone(routeNumber)) throw new Error('Invalid team route.');
  const twiml = `<Response><Say>${xml('This is Aval, an automated assistant. ' + script)}</Say>${routeNumber ? `<Dial timeout="25" timeLimit="1800"><Number>${xml(routeNumber)}</Number></Dial>` : '<Hangup/>'}</Response>`;
  const result = record(await providerJson(`https://api.twilio.com/2010-04-01/Accounts/${safeSegment(credentials.accountSid)}/Calls.json`, { method: 'POST', headers: { authorization: basicAuth(credentials.accountSid, credentials.authToken), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: to, From: from, Twiml: twiml, StatusCallback: callback, StatusCallbackMethod: 'POST', TimeLimit: '1800' }) }));
  return { id: requiredString(result.sid), status: 'accepted' as const };
}
