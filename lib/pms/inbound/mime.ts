/**
 * The message a verified seat mail actually is — RFC 822/2045/2047, no more.
 *
 * This is the shared half of P1.1. Everything a PMS notification carries that
 * is *standardised* is parsed here: the header block, encoded-word subjects,
 * multipart structure, transfer encodings, attachment metadata. What a
 * particular vendor puts in that body is not standardised and is not guessed at
 * — see `notifications.ts` for where per-provider extraction plugs in and why
 * there is none yet.
 *
 * No dependencies, deliberately. This runs inside `aval-pms-seat-reader`, and
 * an email parser is the wrong place to pull a package into an isolate whose
 * input is mail from strangers.
 *
 * ## What it will not do
 *
 * Attachment *content* is never returned. The raw message stays in R2 and can
 * be fetched deliberately; a parser that hands an agent a decoded attachment by
 * default turns "read my notifications" into "open anything anyone sends".
 * Filenames, types and sizes come back so a workflow can say what arrived.
 *
 * Sizes are capped. A verified sender is a party the customer consented to, not
 * a party we trust with unbounded storage.
 *
 * ## On decoding from a string
 *
 * The caller has already decoded the raw bytes as UTF-8 (the sweep does, once,
 * non-fatally). Base64 and quoted-printable payloads are pure ASCII, so they
 * survive that decode intact and re-decoding them here is exact. Binary
 * attachment bodies may be lossy in that string — which does not matter,
 * because their content is deliberately discarded.
 */

/** Per text part, and for the message's assembled text. A notification is small. */
const MAX_TEXT = 128 * 1024;
/** A malformed or hostile message must not be able to make parsing unbounded. */
const MAX_PARTS = 50;
const MAX_HEADER_VALUE = 4096;

export interface AttachmentRef {
  filename: string | null;
  contentType: string;
  /** Encoded length in the message. Approximate for base64; never the content. */
  bytes: number;
}

export interface ParsedMessage {
  /** Decoded and unfolded. Keys are lowercase; a repeated header keeps every value. */
  headers: ReadonlyMap<string, readonly string[]>;
  subject: string | null;
  /** The `From:` header, decoded. A claim by the sender — verified separately. */
  from: string | null;
  date: Date | null;
  messageId: string | null;
  /** text/plain, concatenated across parts, decoded and capped. */
  text: string | null;
  /** text/html, same. Not sanitised here: storage is not rendering. */
  html: string | null;
  attachments: AttachmentRef[];
  /** True when a cap was hit, so a caller never mistakes truncation for the whole. */
  truncated: boolean;
}

/**
 * Header lines with continuations folded back on.
 *
 * Splits on the first blank line, per RFC 822 — everything before it is headers,
 * whatever it looks like. Accepts bare LF as well as CRLF, because mail that has
 * been through a gateway often arrives that way and refusing it would drop real
 * notifications.
 */
export function splitMessage(raw: string): { headerBlock: string; body: string } {
  const boundary = raw.search(/\r?\n\r?\n/);
  if (boundary < 0) return { headerBlock: raw, body: "" };
  const separator = raw.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length ?? 2;
  return { headerBlock: raw.slice(0, boundary), body: raw.slice(boundary + separator) };
}

function foldedLines(headerBlock: string): string[] {
  const lines: string[] = [];
  for (const line of headerBlock.split(/\r?\n/)) {
    // A line starting with whitespace continues the previous one.
    if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += ` ${line.trim()}`;
    else lines.push(line);
  }
  return lines;
}

export function parseHeaders(headerBlock: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  for (const line of foldedLines(headerBlock)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim().slice(0, MAX_HEADER_VALUE);
    const existing = headers.get(name);
    if (existing) existing.push(value);
    else headers.set(name, [value]);
  }
  return headers;
}

function decodeBase64ToBytes(value: string): Uint8Array {
  // Whitespace is legal inside base64 in mail and `atob` rejects it.
  const cleaned = value.replace(/[^A-Za-z0-9+/=]/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    // An unknown or unsupported label must not lose the message. UTF-8 with
    // replacement characters is worse to read and better than nothing.
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeQuotedPrintable(value: string, charset: string): string {
  // Soft line breaks first, then hex escapes, then charset — in that order,
  // because =3D=0A means an escaped byte, not a soft break.
  const unfolded = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    const char = unfolded[index];
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(unfolded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      // Already-decoded characters above the ASCII range can appear in 8-bit
      // mail labelled quoted-printable. Encode them back to bytes so the
      // charset decode below sees a consistent stream.
      const code = char.charCodeAt(0);
      if (code < 128) bytes.push(code);
      else for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
    }
  }
  return decodeCharset(new Uint8Array(bytes), charset);
}

/**
 * RFC 2047 encoded-words, as they appear in a `Subject:`.
 *
 * `=?UTF-8?Q?Work_order_#4021?=` is what an operator needs to read; leaving it
 * raw makes every non-ASCII subject illegible, and PMS notifications carry
 * addresses and names.
 */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([A-Za-z0-9._-]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset: string, encoding: string, payload: string) => {
      try {
        if (encoding.toLowerCase() === "b") return decodeCharset(decodeBase64ToBytes(payload), charset);
        // In Q encoding, and only there, `_` means a space.
        return decodeQuotedPrintable(payload.replace(/_/g, " "), charset);
      } catch {
        // A malformed encoded-word stays as it was rather than eating the header.
        return whole;
      }
    },
  );
}

export function parseContentType(value: string | undefined): { type: string; parameters: Map<string, string> } {
  const parameters = new Map<string, string>();
  if (!value) return { type: "text/plain", parameters };
  const [head, ...rest] = value.split(";");
  for (const parameter of rest) {
    const equals = parameter.indexOf("=");
    if (equals < 0) continue;
    const name = parameter.slice(0, equals).trim().toLowerCase();
    let parameterValue = parameter.slice(equals + 1).trim();
    if (parameterValue.startsWith('"')) parameterValue = parameterValue.slice(1, parameterValue.lastIndexOf('"'));
    parameters.set(name, parameterValue);
  }
  return { type: head.trim().toLowerCase() || "text/plain", parameters };
}

function decodePart(body: string, encoding: string, charset: string): string {
  const normalized = encoding.trim().toLowerCase();
  if (normalized === "base64") return decodeCharset(decodeBase64ToBytes(body), charset);
  if (normalized === "quoted-printable") return decodeQuotedPrintable(body, charset);
  if (charset.toLowerCase() === "utf-8" || charset === "") return body;
  // 7bit/8bit/binary with a non-UTF-8 charset: the caller's UTF-8 decode already
  // happened, so round-trip through bytes to honour the declared charset.
  return decodeCharset(new TextEncoder().encode(body), charset);
}

/** Split a multipart body on its boundary, dropping the preamble and epilogue. */
function splitParts(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const segments = body.split(delimiter);
  // First segment is the preamble; a segment starting with `--` is the close.
  return segments
    .slice(1)
    .filter((segment) => !segment.startsWith("--"))
    .map((segment) => segment.replace(/^\r?\n/, ""))
    .slice(0, MAX_PARTS);
}

interface Collected {
  text: string[];
  html: string[];
  attachments: AttachmentRef[];
  truncated: boolean;
  parts: number;
}

function collect(headerBlock: string, body: string, into: Collected, depth: number): void {
  if (into.parts >= MAX_PARTS || depth > 8) {
    into.truncated = true;
    return;
  }
  into.parts += 1;

  const headers = parseHeaders(headerBlock);
  const { type, parameters } = parseContentType(headers.get("content-type")?.[0]);
  const encoding = headers.get("content-transfer-encoding")?.[0] ?? "7bit";
  const charset = parameters.get("charset") ?? "utf-8";
  const disposition = headers.get("content-disposition")?.[0] ?? "";

  if (type.startsWith("multipart/")) {
    const boundary = parameters.get("boundary");
    if (!boundary) return;
    for (const part of splitParts(body, boundary)) {
      const split = splitMessage(part);
      collect(split.headerBlock, split.body, into, depth + 1);
    }
    return;
  }

  const attached = /^\s*attachment/i.test(disposition) || parameters.has("name")
    || /filename=/i.test(disposition);

  if (attached) {
    const filename = /filename\*?=("?)([^";]+)\1/i.exec(disposition)?.[2] ?? parameters.get("name") ?? null;
    // Metadata only. The content is deliberately not decoded or kept.
    into.attachments.push({
      filename: filename ? decodeEncodedWords(filename).slice(0, 255) : null,
      contentType: type,
      bytes: body.length,
    });
    return;
  }

  if (type !== "text/plain" && type !== "text/html") return;

  let decoded: string;
  try {
    decoded = decodePart(body, encoding, charset);
  } catch {
    // A part that cannot be decoded is dropped and flagged, never guessed at.
    into.truncated = true;
    return;
  }

  const target = type === "text/html" ? into.html : into.text;
  const remaining = MAX_TEXT - target.reduce((total, chunk) => total + chunk.length, 0);
  if (remaining <= 0) {
    into.truncated = true;
    return;
  }
  if (decoded.length > remaining) into.truncated = true;
  const kept = decoded.slice(0, remaining).trim();
  // An empty part contributes nothing. Pushing it would make `text` an empty
  // string instead of null, and every caller checks for null to mean "no body".
  if (kept !== "") target.push(kept);
}

export function parseMessage(raw: string): ParsedMessage {
  const { headerBlock, body } = splitMessage(raw);
  const headers = parseHeaders(headerBlock);

  const into: Collected = { text: [], html: [], attachments: [], truncated: false, parts: 0 };
  collect(headerBlock, body, into, 0);

  const dateHeader = headers.get("date")?.[0];
  const parsedDate = dateHeader ? new Date(dateHeader) : null;

  return {
    headers,
    subject: headers.get("subject")?.[0] ? decodeEncodedWords(headers.get("subject")![0]) : null,
    from: headers.get("from")?.[0] ? decodeEncodedWords(headers.get("from")![0]) : null,
    // An unparsable Date is null rather than "now": a notification's own
    // timestamp is evidence, and substituting the clock would invent it.
    date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    messageId: headers.get("message-id")?.[0] ?? null,
    text: into.text.length > 0 ? into.text.join("\n\n") : null,
    html: into.html.length > 0 ? into.html.join("\n\n") : null,
    attachments: into.attachments,
    truncated: into.truncated,
  };
}
