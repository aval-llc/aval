import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeEncodedWords,
  parseContentType,
  parseHeaders,
  parseMessage,
  splitMessage,
} from "../lib/pms/inbound/mime.ts";

/**
 * The standardised half of a PMS notification.
 *
 * Every message here is one this parser will actually meet: folded headers,
 * encoded-word subjects, quoted-printable bodies, nested multiparts, attachments
 * that must not be decoded. What a vendor writes *inside* the body is not
 * standardised and is not parsed anywhere — see lib/pms/inbound/notifications.ts.
 */

const CRLF = "\r\n";

function message(lines: string[], body: string): string {
  return `${lines.join(CRLF)}${CRLF}${CRLF}${body}`;
}

test("headers split at the first blank line, whatever follows it", () => {
  const raw = message(["Subject: Work order", "From: a@b.example"], "Subject: not a header\n\nbody");
  const { headerBlock, body } = splitMessage(raw);
  assert.match(headerBlock, /^Subject: Work order/);
  // A body that looks like headers is still a body. Anything else would let a
  // sender inject headers by writing them below the blank line.
  assert.match(body, /^Subject: not a header/);
});

test("a folded header is read as one value", () => {
  const headers = parseHeaders(
    `Subject: Work order 4021${CRLF}\tassigned to you${CRLF}From: notifications@appfolio.com`,
  );
  assert.equal(headers.get("subject")?.[0], "Work order 4021 assigned to you");
  assert.equal(headers.get("from")?.[0], "notifications@appfolio.com");
});

test("a repeated header keeps every value, in order", () => {
  // Load-bearing elsewhere: authentication.ts depends on being able to see each
  // Authentication-Results separately rather than a joined string.
  const headers = parseHeaders(
    `Received: from one${CRLF}Received: from two${CRLF}Received: from three`,
  );
  assert.deepEqual(headers.get("received"), ["from one", "from two", "from three"]);
});

test("bare LF line endings parse, because gateways produce them", () => {
  const raw = "Subject: Leak reported\nFrom: a@b.example\n\nThe kitchen sink is leaking.";
  const parsed = parseMessage(raw);
  assert.equal(parsed.subject, "Leak reported");
  assert.equal(parsed.text, "The kitchen sink is leaking.");
});

test("an encoded-word subject is decoded, in both encodings", () => {
  assert.equal(
    decodeEncodedWords("=?UTF-8?Q?Orden_de_trabajo_#4021_=E2=80=94_Ca=C3=B1er=C3=ADa?="),
    "Orden de trabajo #4021 — Cañería",
  );
  assert.equal(
    decodeEncodedWords("=?utf-8?B?V29yayBvcmRlciDigJQgNDAyMQ==?="),
    "Work order — 4021",
  );
  // `_` is a space in Q encoding and only there.
  assert.equal(decodeEncodedWords("=?UTF-8?Q?a_b?="), "a b");
});

test("a malformed encoded-word is left alone rather than eating the header", () => {
  const value = "=?UTF-8?Q?unterminated";
  assert.equal(decodeEncodedWords(value), value);
  assert.equal(decodeEncodedWords("=?NONSENSE-CHARSET?B?aGVsbG8=?="), "hello");
});

test("content-type parameters are parsed, quoted or not", () => {
  const quoted = parseContentType('multipart/alternative; boundary="--=_Part_12_34"; charset="utf-8"');
  assert.equal(quoted.type, "multipart/alternative");
  assert.equal(quoted.parameters.get("boundary"), "--=_Part_12_34");
  assert.equal(quoted.parameters.get("charset"), "utf-8");

  const bare = parseContentType("TEXT/PLAIN; charset=iso-8859-1");
  assert.equal(bare.type, "text/plain", "the type is lowercased for comparison");
  assert.equal(bare.parameters.get("charset"), "iso-8859-1");

  // A message with no content-type is text/plain by RFC 2045.
  assert.equal(parseContentType(undefined).type, "text/plain");
});

test("a quoted-printable body is decoded, soft breaks and all", () => {
  const raw = message(
    ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: quoted-printable"],
    "The unit at 14 Alder St=20has a leak under the=\r\n sink. Tenant: Jos=C3=A9.",
  );
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, "The unit at 14 Alder St has a leak under the sink. Tenant: José.");
});

test("a base64 body is decoded with its declared charset", () => {
  const body = Buffer.from("Rent posted: $1,450 — unit 3B", "utf8").toString("base64");
  const parsed = parseMessage(message(
    ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"],
    body,
  ));
  assert.equal(parsed.text, "Rent posted: $1,450 — unit 3B");
});

test("base64 split across lines decodes, since atob would refuse it", () => {
  const raw = Buffer.from("A work order was assigned to Aval for unit 12C.", "utf8").toString("base64");
  const wrapped = raw.replace(/(.{20})/g, `$1${CRLF}`);
  const parsed = parseMessage(message(
    ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"],
    wrapped,
  ));
  assert.equal(parsed.text, "A work order was assigned to Aval for unit 12C.");
});

test("multipart/alternative yields both the text and the html", () => {
  const boundary = "=_Part_9001";
  const raw = message(
    ["Subject: Work order assigned", `Content-Type: multipart/alternative; boundary="${boundary}"`],
    [
      "preamble nobody reads",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Work order 4021 assigned.",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Work order 4021 assigned.</p>",
      `--${boundary}--`,
      "epilogue",
    ].join(CRLF),
  );
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, "Work order 4021 assigned.");
  assert.equal(parsed.html, "<p>Work order 4021 assigned.</p>");
  assert.equal(parsed.subject, "Work order assigned");
});

test("a nested multipart/mixed wrapping an alternative is walked", () => {
  const outer = "=_Outer_1";
  const inner = "=_Inner_2";
  const raw = message(
    [`Content-Type: multipart/mixed; boundary="${outer}"`],
    [
      `--${outer}`,
      `Content-Type: multipart/alternative; boundary="${inner}"`,
      "",
      `--${inner}`,
      "Content-Type: text/plain",
      "",
      "Invoice attached.",
      `--${inner}--`,
      `--${outer}`,
      "Content-Type: application/pdf; name=\"invoice-4021.pdf\"",
      "Content-Disposition: attachment; filename=\"invoice-4021.pdf\"",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQKJfbk",
      `--${outer}--`,
    ].join(CRLF),
  );
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, "Invoice attached.");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, "invoice-4021.pdf");
  assert.equal(parsed.attachments[0].contentType, "application/pdf");
});

test("an attachment's content is never returned, only what it is", () => {
  const secret = Buffer.from("this content must not be handed to an agent").toString("base64");
  const boundary = "=_Part_7";
  const raw = message(
    [`Content-Type: multipart/mixed; boundary="${boundary}"`],
    [
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "See attached.",
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="payload.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      secret,
      `--${boundary}--`,
    ].join(CRLF),
  );
  const parsed = parseMessage(raw);
  // The whole parsed result, serialized: the attachment body appears nowhere.
  const serialized = JSON.stringify(parsed, (key, value) => (key === "headers" ? undefined : value));
  assert.doesNotMatch(serialized, /must not be handed/);
  assert.doesNotMatch(serialized, new RegExp(secret.slice(0, 24)));
  assert.equal(parsed.attachments[0].filename, "payload.bin");
  assert.ok(parsed.attachments[0].bytes > 0, "the size is reported without the content");
});

test("an attachment with an encoded-word filename is readable", () => {
  const boundary = "=_Part_8";
  const raw = message(
    [`Content-Type: multipart/mixed; boundary="${boundary}"`],
    [
      `--${boundary}`,
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="=?UTF-8?Q?Contrato_de_arrendamiento.pdf?="',
      "",
      "x",
      `--${boundary}--`,
    ].join(CRLF),
  );
  assert.equal(parseMessage(raw).attachments[0].filename, "Contrato de arrendamiento.pdf");
});

test("an unparsable Date is null, never the clock", () => {
  // A notification's own timestamp is evidence. Substituting `now` would invent
  // it, and the row it lands in is what a workflow orders by.
  assert.equal(parseMessage(message(["Date: not a date"], "body")).date, null);
  assert.equal(parseMessage(message(["Subject: no date at all"], "body")).date, null);
  assert.deepEqual(
    parseMessage(message(["Date: Thu, 17 Sep 2026 18:40:00 -0700"], "body")).date,
    new Date("2026-09-17T18:40:00-07:00"),
  );
});

test("a message with no body parses rather than throwing", () => {
  const parsed = parseMessage("Subject: Ping only");
  assert.equal(parsed.subject, "Ping only");
  assert.equal(parsed.text, null);
  assert.equal(parsed.html, null);
});

test("an oversized body is truncated and says so", () => {
  const parsed = parseMessage(message(["Content-Type: text/plain"], "x".repeat(200 * 1024)));
  assert.equal(parsed.truncated, true, "a caller must never mistake truncation for the whole message");
  assert.ok((parsed.text?.length ?? 0) <= 128 * 1024);
});

test("a multipart with no boundary parameter yields no parts instead of hanging", () => {
  const parsed = parseMessage(message(["Content-Type: multipart/mixed"], "--nope\r\nContent-Type: text/plain\r\n\r\nhi"));
  assert.equal(parsed.text, null);
});

test("a part count bomb is capped", () => {
  const boundary = "=_b";
  const parts = Array.from({ length: 200 }, (_, index) =>
    [`--${boundary}`, "Content-Type: text/plain", "", `part ${index}`].join(CRLF)).join(CRLF);
  const parsed = parseMessage(message(
    [`Content-Type: multipart/mixed; boundary="${boundary}"`],
    `${parts}${CRLF}--${boundary}--`,
  ));
  assert.equal(parsed.truncated, true);
});

test("an iso-8859-1 part is decoded by its declared charset", () => {
  const parsed = parseMessage(message(
    ["Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable"],
    "Tenant: Jos=E9 Garc=EDa",
  ));
  assert.equal(parsed.text, "Tenant: José García");
});
