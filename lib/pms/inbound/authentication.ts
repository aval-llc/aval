/**
 * Whether a message that reached the seat is really from who it claims
 * (docs/PMS_INTEGRATION.md, P1 — the gate on the read envelope).
 *
 * `worker/pms-seat-inbound.ts` stores every message unparsed and marks it
 * `verified: "false"`, because the seat addresses are discoverable and anyone
 * can send to them claiming to be AppFolio. This module is what decides that a
 * stored message may be read. Nothing downstream may parse a message this says
 * no about.
 *
 * ## Why this parses the raw message rather than the stored header
 *
 * The Worker records `headers.get("authentication-results")`, and that is not
 * safe to verify against. `Headers.get` joins duplicate headers with a comma,
 * and the *sender* controls the headers in the message they send. A sender who
 * includes their own
 *
 *     Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=appfolio.com
 *
 * gets it stored alongside the real one, in a single string, with nothing to
 * say which is which. Cloudflare adds its own result at the top of the header
 * block and RFC 8601 §5 tells a receiver to strip pre-existing results bearing
 * its own authserv-id — but "presumably it did" is not a basis for trusting a
 * message into an agent's context.
 *
 * So verification reads the raw RFC 822 header block and takes the **topmost**
 * `Authentication-Results` whose authserv-id we expect. Topmost is the one the
 * receiving MTA added last, which is the only one Cloudflare could have written.
 * Anything a sender embedded is below it and is ignored.
 *
 * The stored `authenticationResults` metadata stays useful for triage. It is
 * not evidence.
 *
 * **The residual assumption, stated so nobody has to rediscover it:** this holds
 * because Cloudflare adds its own result to every message Email Routing accepts.
 * If a path ever delivered a message without one, a sender's forged header would
 * be the topmost bearing that authserv-id and would be believed. That is why the
 * expected authserv-id is passed in explicitly rather than matched loosely, and
 * why a message with no trusted result is refused outright instead of falling
 * back to the envelope.
 */

/** What an allowlisted domain was proven by. SPF alone is never enough — see below. */
export type AuthMethod = "dmarc" | "dkim";

export interface SenderVerdict {
  verified: boolean;
  /** The domain that was actually authenticated, when one was. */
  domain?: string;
  method?: AuthMethod;
  /** Why, in words an operator reviewing a quarantined message can act on. */
  reason: string;
}

export interface AuthenticationResults {
  authservId: string;
  /** method → result, lowercased (`dmarc` → `pass`). */
  results: ReadonlyMap<string, string>;
  /** Property values seen, keyed `ptype.property` (`header.d` → `appfolio.com`). */
  properties: ReadonlyMap<string, string>;
}

/**
 * The header block of an RFC 822 message: everything before the first blank
 * line, with continuation lines folded back onto their header.
 */
function headerLines(raw: string): string[] {
  const end = raw.search(/\r?\n\r?\n/);
  const block = end === -1 ? raw : raw.slice(0, end);
  const lines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    // A line starting with whitespace continues the previous one (RFC 822 §3.1.1).
    if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += " " + line.trim();
    else lines.push(line);
  }
  return lines;
}

function stripComments(value: string): string {
  // RFC 8601 permits CFWS comments, e.g. `spf=pass (google.com: domain of ...)`.
  // They carry no meaning here and can contain anything, including text shaped
  // like another result.
  let depth = 0;
  let out = "";
  for (const char of value) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out;
}

/**
 * The topmost `Authentication-Results` bearing the expected authserv-id.
 *
 * Returns null when there is none — which includes the case where the only ones
 * present came from the sender.
 */
export function parseAuthenticationResults(raw: string, expectedAuthservId: string): AuthenticationResults | null {
  const expected = expectedAuthservId.trim().toLowerCase();
  for (const line of headerLines(raw)) {
    const match = /^authentication-results\s*:(.*)$/i.exec(line);
    if (!match) continue;

    const parts = stripComments(match[1]).split(";").map((part) => part.trim()).filter(Boolean);
    const authservId = (parts.shift() ?? "").split(/\s+/)[0].toLowerCase();
    // Not ours: a relay's own result, or one the sender wrote. Keep looking
    // *downward* rather than accepting it — but never past one that is ours.
    if (authservId !== expected) continue;

    const results = new Map<string, string>();
    const properties = new Map<string, string>();
    for (const part of parts) {
      const [head, ...rest] = part.split(/\s+/);
      const eq = head.indexOf("=");
      if (eq <= 0) continue;
      const method = head.slice(0, eq).toLowerCase();
      // `dkim=pass/policy` — the result is up to the first slash.
      results.set(method, head.slice(eq + 1).toLowerCase().split("/")[0]);
      for (const property of rest) {
        const split = property.indexOf("=");
        if (split <= 0) continue;
        properties.set(property.slice(0, split).toLowerCase(), property.slice(split + 1).replace(/^["']|["']$/g, "").toLowerCase());
      }
    }
    return { authservId, results, properties };
  }
  return null;
}

/** The domain part of an address or bare domain, normalised. */
export interface AuthenticatedDomain {
  domain: string;
  method: AuthMethod;
}

/**
 * The domain a message actually authenticated as, independent of any allowlist.
 *
 * Separate from `verifySender` because the two questions are different and
 * conflating them cost the held-sender review its whole purpose: `verifySender`
 * refuses an empty allowlist before it looks at the headers, which is correct —
 * absence is not permission — but it means the verdict carries no domain exactly
 * when a workspace has allowlisted nothing. That is first contact, the one case
 * where naming the sender is the entire point.
 *
 * DMARC first, because that is the claim about the `From:` a person reads. DKIM
 * second, on its signing domain. Nothing else authenticates a domain here: an
 * SPF pass is about the envelope and says nothing about either.
 */
export function authenticatedDomain(auth: AuthenticationResults | null): AuthenticatedDomain | null {
  if (!auth) return null;

  const dmarcDomain = domainOf(auth.properties.get("header.from"));
  if (auth.results.get("dmarc") === "pass" && dmarcDomain) {
    return { domain: dmarcDomain, method: "dmarc" };
  }

  const dkimDomain = domainOf(auth.properties.get("header.d"));
  if (auth.results.get("dkim") === "pass" && dkimDomain) {
    return { domain: dkimDomain, method: "dkim" };
  }

  return null;
}

export interface AuthenticatedAddress {
  /** The full mailbox, lowercased: `john@gmail.com`. */
  address: string;
  domain: string;
}

/**
 * The exact mailbox a message authenticated as, when that claim is sound.
 *
 * `authenticatedDomain` answers "which domain", which is all a domain grant
 * needs. An address grant needs more, because the whole point of one is that
 * approving `john@gmail.com` must not approve `attacker@gmail.com` — and on a
 * consumer mailbox provider those two differ only in the local part.
 *
 * Three conditions, and each rules out a way the local part could be attacker
 * chosen:
 *
 *   - **DMARC passed.** Without it the From domain is not authenticated at all.
 *   - **DKIM passed, by a domain aligned with the From domain.** DMARC alignment
 *     can be satisfied by SPF alone, and SPF authenticates the envelope sender.
 *     A message can be SPF-aligned for `gmail.com` while carrying any From local
 *     part at all, so DMARC on its own is not enough to trust a mailbox. A DKIM
 *     signature by the From domain is, because the signature covers the header.
 *   - **Exactly one `From:`, whose domain is the authenticated one.** Two From
 *     headers is ambiguous — clients differ on which they display — and that
 *     disagreement is the spoof.
 *
 * The residual assumption, stated rather than left to be rediscovered: this
 * holds because a DKIM signature made for DMARC alignment covers the `From`
 * header. RFC 6376 does not *require* `from` in `h=`, but DMARC evaluation
 * treats a signature that omits it as non aligned, and `Authentication-Results`
 * gives us no way to read `h=` back. A signer that both omitted `From` and was
 * still reported aligned would break this; no deployed one does.
 *
 * Subdomain alignment is accepted in both directions, which is DMARC's relaxed
 * mode: `mail.example.com` signing for `example.com`, and the reverse.
 */
export function authenticatedAddress(
  auth: AuthenticationResults | null,
  raw: string,
): AuthenticatedAddress | null {
  const authenticated = authenticatedDomain(auth);
  if (!auth || !authenticated || authenticated.method !== "dmarc") return null;

  const signing = domainOf(auth.properties.get("header.d"));
  if (auth.results.get("dkim") !== "pass" || !signing) return null;
  if (!domainMatches(authenticated.domain, signing) && !domainMatches(signing, authenticated.domain)) {
    return null;
  }

  const address = soleFromAddress(raw);
  if (!address) return null;
  // Exact, not `domainMatches`: a grant to one mailbox says nothing about a
  // subdomain, and subdomains are where a lookalike local part would hide.
  if (address.slice(address.lastIndexOf("@") + 1) !== authenticated.domain) return null;

  return { address, domain: authenticated.domain };
}

/**
 * The single mailbox in the `From:` header, or nothing.
 *
 * Fails closed on everything ambiguous — no From, several From headers, a group
 * or a list, an unterminated angle bracket. Every one of those falls back to the
 * domain and review tiers, which is the right place for a message nobody can
 * read one sender out of.
 */
function soleFromAddress(raw: string): string | undefined {
  const from = headerLines(raw).filter((line) => /^from\s*:/i.test(line));
  if (from.length !== 1) return undefined;

  let value = stripComments(from[0].replace(/^from\s*:/i, "")).trim();
  // A quoted display name may legally contain a comma or an angle bracket, so
  // it goes before either is treated as structure.
  const bare = value.replace(/"(?:[^"\\]|\\.)*"/g, "");
  if (bare.includes(",")) return undefined;

  const angle = bare.lastIndexOf("<");
  if (angle >= 0) {
    const source = value.lastIndexOf("<");
    const close = value.indexOf(">", source);
    if (close < 0) return undefined;
    value = value.slice(source + 1, close);
  } else if (value !== bare) {
    // A display name with no angle brackets is not a parsable mailbox.
    return undefined;
  }

  value = value.trim().toLowerCase().replace(/\.$/, "");
  return /^[^\s@"'<>,;]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(value)
    ? value
    : undefined;
}

/**
 * Every authserv-id present on the message, in the order the headers appear.
 *
 * For triage, not for verification — the topmost id is the only one that could
 * have come from the receiving MTA and `parseAuthenticationResults` already
 * insists on it. This exists because the id Cloudflare stamps is not documented
 * anywhere we could find, so a wrong `expectedAuthservId` fails every message
 * closed and looks identical to "no PMS has written to us yet". One query over
 * these answers which of the two it is.
 */
export function observedAuthservIds(raw: string): string[] {
  const ids: string[] = [];
  for (const line of headerLines(raw)) {
    const [name, ...rest] = line.split(":");
    if (name.trim().toLowerCase() !== "authentication-results") continue;
    const id = stripComments(rest.join(":")).split(";")[0].trim().toLowerCase();
    if (id) ids.push(id);
  }
  return ids;
}

function domainOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const at = value.lastIndexOf("@");
  const domain = (at === -1 ? value : value.slice(at + 1)).trim().toLowerCase().replace(/\.$/, "");
  return domain === "" ? undefined : domain;
}

/**
 * Does an authenticated domain satisfy an allowlist entry?
 *
 * Exact match, or a subdomain of it. PMS vendors routinely send notifications
 * from `mail.` or `notifications.` subdomains, and requiring a customer to
 * enumerate them would mean an allowlist that is wrong the first time the vendor
 * adds one — and a customer who works around it by allowlisting something too
 * broad.
 *
 * The boundary is a literal dot, so `notappfolio.com` does not match
 * `appfolio.com`. Suffix matching without that check is the classic way this
 * goes wrong.
 */
export function domainMatches(authenticated: string, allowed: string): boolean {
  const a = authenticated.toLowerCase().replace(/\.$/, "");
  const b = allowed.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  if (b === "") return false;
  return a === b || a.endsWith(`.${b}`);
}

/**
 * Whether this message may be read, given the workspace's allowlist.
 *
 * Two ways to pass, and SPF alone is deliberately not one of them:
 *
 *   - `dmarc=pass` — the From header's domain is authenticated, by definition of
 *     DMARC (an aligned SPF or DKIM pass). This is the claim we care about,
 *     because it is the domain a human reading the message would see.
 *   - `dkim=pass` with a signing domain (`header.d`) on the allowlist — the
 *     allowlisted party signed this message, whatever the envelope says.
 *
 * SPF authenticates the envelope sender (`smtp.mailfrom`), which need not have
 * any relationship to the `From:` a person or a parser reads. A message can be
 * SPF-clean for `bounces.somerandomhost.com` and display as being from
 * AppFolio. Accepting that would make the allowlist decorative.
 */
export function verifySender(
  auth: AuthenticationResults | null,
  allowlist: readonly string[],
): SenderVerdict {
  if (allowlist.length === 0) {
    // An empty allowlist is a workspace that has not said who may write to its
    // seat. Absence is not permission — the same rule as enablement.ts.
    return { verified: false, reason: "This workspace has not allowlisted any sender for its Aval seat." };
  }
  if (!auth) {
    return {
      verified: false,
      reason: "No trusted Authentication-Results header was present, so the sender could not be checked.",
    };
  }

  const dmarcDomain = domainOf(auth.properties.get("header.from"));
  if (auth.results.get("dmarc") === "pass" && dmarcDomain) {
    const allowed = allowlist.find((entry) => domainMatches(dmarcDomain, entry));
    if (allowed) return { verified: true, domain: dmarcDomain, method: "dmarc", reason: `DMARC pass for ${dmarcDomain}.` };
  }

  const dkimDomain = domainOf(auth.properties.get("header.d"));
  if (auth.results.get("dkim") === "pass" && dkimDomain) {
    const allowed = allowlist.find((entry) => domainMatches(dkimDomain, entry));
    if (allowed) return { verified: true, domain: dkimDomain, method: "dkim", reason: `DKIM signature by ${dkimDomain}.` };
  }

  // Named separately from a plain failure: an operator seeing this knows to add
  // a domain, not to investigate a forgery.
  //
  // Taken from `authenticatedDomain` rather than `dmarcDomain ?? dkimDomain`,
  // which was wrong in a way that mattered: with `dmarc=fail` and `dkim=pass` it
  // returned the *failing* `header.from`, so a verdict could name a domain the
  // message had not authenticated as — and `header.from` is chosen by the sender.
  const authenticated = authenticatedDomain(auth);
  if (authenticated) {
    return {
      verified: false,
      domain: authenticated.domain,
      method: authenticated.method,
      reason: `${authenticated.domain} is authenticated but not allowlisted for this workspace.`,
    };
  }

  const spf = auth.results.get("spf");
  if (spf === "pass") {
    // Worth saying explicitly, because "SPF passed" reads like success.
    return {
      verified: false,
      reason: "Only SPF passed. SPF authenticates the envelope sender, not the From address, so it cannot establish who sent this.",
    };
  }

  return {
    verified: false,
    reason: `Sender authentication did not pass (dmarc=${auth.results.get("dmarc") ?? "none"}, dkim=${auth.results.get("dkim") ?? "none"}, spf=${spf ?? "none"}).`,
  };
}
