/**
 * Extracts a real inbound message from a provider's webhook payload — pure
 * parsing, no DB access, so it can be unit-reasoned about independently of
 * how the caller resolves which organization it belongs to. Shapes match
 * each provider's real, documented webhook format; a payload that doesn't
 * carry an actual new inbound message (delivery receipts, edits, join
 * events, bot's own messages) returns null rather than a best guess.
 */

export interface InboundMessage {
  // Set only for connection-scoped webhook URLs (telegram, apple_messages),
  // where the connection id is already in the URL's query string.
  connectionId?: string;
  // Set only when the org must be resolved by matching this against
  // integration_connections.externalAccountId for the provider (slack team
  // id, whatsapp phone_number_id, twilio AccountSid) — the URL itself
  // carries no per-org information for these providers.
  externalAccountKey?: string;
  externalThreadId: string;
  externalMessageId: string;
  contactDisplayName: string;
  body: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Split at the message boundary, retaining the verified destination metadata. */
export function splitWhatsappPayload(payload: Record<string, unknown>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(asRecord(entry)?.changes) ? asRecord(entry)!.changes as unknown[] : []) {
      const value = asRecord(asRecord(change)?.value);
      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        const sender = asRecord(message)?.from;
        const contacts = Array.isArray(value?.contacts) ? value.contacts.filter(c => asRecord(c)?.wa_id === sender) : [];
        result.push({ ...payload, entry: [{ ...asRecord(entry), changes: [{ ...asRecord(change), value: { ...value, contacts, messages: [message] } }] }] });
      }
    }
  }
  return result;
}

function parseTelegram(payload: Record<string, unknown>, connectionId: string | null): InboundMessage | null {
  if (!connectionId) return null;
  const message = asRecord(payload.message);
  const text = message?.text;
  const chat = asRecord(message?.chat);
  if (!message || typeof text !== "string" || chat?.id === undefined) return null;
  const from = asRecord(message.from);
  const name = [from?.first_name, from?.last_name].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ")
    || (typeof from?.username === "string" ? from.username : "Telegram contact");
  return {
    connectionId,
    externalThreadId: String(chat.id),
    externalMessageId: String(message.message_id ?? crypto.randomUUID()),
    contactDisplayName: name,
    body: text,
  };
}

function parseWhatsapp(payload: Record<string, unknown>): InboundMessage | null {
  const entry = (payload.entry as unknown[] | undefined)?.[0];
  const change = (asRecord(entry)?.changes as unknown[] | undefined)?.[0];
  const value = asRecord(asRecord(change)?.value);
  const message = asRecord((value?.messages as unknown[] | undefined)?.[0]);
  const text = asRecord(message?.text)?.body;
  const phoneNumberId = asRecord(value?.metadata)?.phone_number_id;
  if (!message || typeof text !== "string" || typeof phoneNumberId !== "string" || typeof message.from !== "string") return null;
  const contact = asRecord((value?.contacts as unknown[] | undefined)?.[0]);
  const name = asRecord(contact?.profile)?.name;
  return {
    externalAccountKey: phoneNumberId,
    externalThreadId: message.from,
    externalMessageId: String(message.id ?? crypto.randomUUID()),
    contactDisplayName: typeof name === "string" && name ? name : message.from,
    body: text,
  };
}

function parseSlack(payload: Record<string, unknown>): InboundMessage | null {
  const event = asRecord(payload.event);
  // subtype is set on edits, joins, and message_changed events — a real new
  // human message has no subtype. bot_id present means Aval would be
  // replying to itself.
  if (!event || event.type !== "message" || event.subtype !== undefined || event.bot_id) return null;
  const text = event.text;
  const teamId = payload.team_id;
  const channel = event.channel;
  const user = event.user;
  if (typeof text !== "string" || typeof teamId !== "string" || typeof channel !== "string" || typeof user !== "string") return null;
  return {
    externalAccountKey: teamId,
    externalThreadId: channel,
    externalMessageId: String(event.ts ?? crypto.randomUUID()),
    contactDisplayName: user,
    body: text,
  };
}

function parseTwilio(payload: Record<string, unknown>): InboundMessage | null {
  const body = payload.Body;
  const from = payload.From;
  const accountSid = payload.AccountSid;
  if (typeof body !== "string" || typeof from !== "string" || typeof accountSid !== "string") return null;
  return {
    externalAccountKey: accountSid,
    externalThreadId: from,
    externalMessageId: String(payload.MessageSid ?? crypto.randomUUID()),
    contactDisplayName: from,
    body,
  };
}

export function parseInboundMessage(provider: string, payload: Record<string, unknown>, connectionIdFromQuery: string | null): InboundMessage | null {
  if (provider === "telegram") return parseTelegram(payload, connectionIdFromQuery);
  if (provider === "whatsapp") return parseWhatsapp(payload);
  if (provider === "slack") return parseSlack(payload);
  if (provider === "twilio") return parseTwilio(payload);
  return null;
}
