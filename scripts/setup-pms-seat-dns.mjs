#!/usr/bin/env node
/**
 * P0.0 — give the Aval seat an address (docs/PMS_INTEGRATION.md).
 *
 * Nothing in the PMS read path receives anything until these addresses exist.
 * A customer adds Aval as a user in their PMS with one of them, and the PMS
 * mails it work-order assignments and resident messages exactly as it would any
 * employee — no API and no partnership required, which is what makes the seat
 * work for a PMS nobody has heard of.
 *
 * Runs in order and stops at the first thing that is not true, rather than
 * working around it:
 *
 *   1. verify the token actually carries Zone:DNS:Edit and Zone:Email Routing:Edit
 *   2. resolve aval.llc and confirm Cloudflare is authoritative for it
 *   3. confirm Email Routing is on for the zone
 *   4. show every existing routing rule, and confirm none of them is disturbed
 *   5. point the apex catch-all at the seat Worker
 *   6. record the anti-spoofing position for the apex-prefix address format
 *
 * Seats are `agent-{orgSlug}@aval.llc` — local parts on the apex. An earlier
 * revision of this script put them on an `agents.aval.llc` subdomain; that was
 * abandoned 2026-09-17 and this script must never create that name or point
 * anything at it. See docs/PMS_INTEGRATION_DISCOVERY.md.
 *
 * Deploy `worker/pms-seat-inbound.ts` BEFORE running this. Email routing cannot
 * target a Worker that does not exist, and step 4 will fail plainly if it does
 * not.
 *
 * Usage:
 *   CF_API_TOKEN=... node scripts/setup-pms-seat-dns.mjs            # dry run
 *   CF_API_TOKEN=... node scripts/setup-pms-seat-dns.mjs --apply    # make changes
 */

const API = "https://api.cloudflare.com/client/v4";
const ZONE_NAME = process.env.PMS_SEAT_ZONE ?? "aval.llc";
// The seat address format. Fixed, not probed: a failed read must never be able
// to change the address every customer is given.
const ADDRESS_FORMAT = `agent-{orgSlug}@${ZONE_NAME}`;
const WORKER_NAME = process.env.PMS_SEAT_WORKER ?? "aval-pms-seat-inbound";
const APPLY = process.argv.includes("--apply");

const TOKEN = process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error(
    "CF_API_TOKEN is not set.\n"
      + "The production token lives in GitHub Actions secrets (CLOUDFLARE_API_TOKEN), which are write-only —\n"
      + "it cannot be read back out. Create a scoped token at\n"
      + "  https://dash.cloudflare.com/profile/api-tokens\n"
      + `with Zone:DNS:Edit and Zone:Email Routing:Edit on ${ZONE_NAME}, then re-run.`,
  );
  process.exit(1);
}

let failed = false;

function step(name) {
  console.log(`\n── ${name}`);
}
function ok(message) {
  console.log(`   ✓ ${message}`);
}
function info(message) {
  console.log(`   · ${message}`);
}
function stop(message) {
  console.error(`   ✗ ${message}`);
  failed = true;
}

async function cf(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok && body.success !== false, status: response.status, body };
}

/** Cloudflare permission groups are named, not coded, so match on the name. */
function hasPermission(policies, needle) {
  return policies.some((policy) =>
    (policy.permission_groups ?? []).some((group) => String(group.name ?? "").toLowerCase().includes(needle))
  );
}

async function main() {
  // ── 1. token scope ─────────────────────────────────────────────────────────
  step("1. Verifying token scope");
  const verified = await cf("/user/tokens/verify");
  if (!verified.ok) {
    stop(`Token verification failed (HTTP ${verified.status}). ${JSON.stringify(verified.body.errors ?? {})}`);
    return;
  }
  ok(`Token is ${verified.body.result?.status ?? "active"}`);

  // `verify` does not return the policy list, so read the token's own details
  // when the id is available. A token that cannot describe itself is reported
  // rather than assumed adequate — the whole point of this step.
  const tokenId = verified.body.result?.id;
  if (tokenId) {
    const details = await cf(`/user/tokens/${tokenId}`);
    if (details.ok) {
      const policies = details.body.result?.policies ?? [];
      const dns = hasPermission(policies, "dns write");
      const email = hasPermission(policies, "email routing");
      info(`DNS write: ${dns ? "yes" : "NOT FOUND"}`);
      info(`Email Routing edit: ${email ? "yes" : "NOT FOUND"}`);
      if (!dns || !email) {
        stop(
          "Token is missing Zone:DNS:Edit and/or Zone:Email Routing:Edit.\n"
            + "     Stopping rather than working around it — a narrower token would half-configure the zone.",
        );
        return;
      }
    } else {
      info("Token details are not readable with this token; scope will be proven by the calls themselves.");
    }
  }

  // ── 2. the zone ────────────────────────────────────────────────────────────
  step(`2. Resolving ${ZONE_NAME}`);
  const zones = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!zones.ok) {
    stop(`Could not list zones (HTTP ${zones.status}). This usually means the token has no access to ${ZONE_NAME}.`);
    return;
  }
  const zone = (zones.body.result ?? [])[0];
  if (!zone) {
    stop(`${ZONE_NAME} is not a zone on this Cloudflare account.`);
    return;
  }
  if (zone.status !== "active") {
    stop(
      `${ZONE_NAME} is "${zone.status}", not "active" — Cloudflare is not authoritative for it yet.\n`
        + "     Nothing downstream works until the nameservers are at Cloudflare. Stopping.",
    );
    return;
  }
  ok(`Zone ${zone.id} is active`);

  // ── 3. email routing ───────────────────────────────────────────────────────
  step("3. Email Routing");
  // A token scoped to Email Routing *Rules* cannot read the zone's Email
  // Routing *settings*, and a failed read is not the same fact as "disabled".
  // Collapsing the two once reported this zone as unconfigured while it was
  // live and forwarding mail, so an unreadable settings endpoint falls back to
  // evidence the DNS scope can see: Cloudflare publishes its own MX on a zone
  // when, and only when, Email Routing is enabled.
  const routing = await cf(`/zones/${zone.id}/email/routing`);
  let enabled;
  if (routing.ok) {
    enabled = routing.body.result?.enabled === true;
    info(`Currently ${enabled ? "enabled" : "not enabled"} (read from settings)`);
  } else {
    info(`Settings unreadable with this token (HTTP ${routing.status}) \u2014 inferring from published MX.`);
    const mx = await cf(`/zones/${zone.id}/dns_records?type=MX&per_page=100`);
    if (!mx.ok) {
      stop(
        "Email Routing state is unknown: neither the settings endpoint nor the MX records are readable.\n"
          + "     Refusing to guess. Grant Zone:Email Routing:Edit and Zone:DNS:Edit, then re-run.",
      );
      return;
    }
    enabled = (mx.body.result ?? []).some((r) => /\.mx\.cloudflare\.net\.?$/i.test(r.content ?? ""));
    info(`Currently ${enabled ? "enabled" : "not enabled"} (inferred from ${enabled ? "present" : "absent"} Cloudflare MX)`);
  }

  if (!enabled) {
    if (!APPLY) {
      info("Would enable Email Routing (dry run).");
    } else {
      const enable = await cf(`/zones/${zone.id}/email/routing/enable`, { method: "POST", body: "{}" });
      if (!enable.ok) {
        stop(`Could not enable Email Routing (HTTP ${enable.status}). ${JSON.stringify(enable.body.errors ?? {})}`);
        return;
      }
      ok("Email Routing enabled");
    }
  }

  // ── 4. what exists today ───────────────────────────────────────────────────
  // The catch-all in step 5 is the only rule that can deliver an address nobody
  // pre-registered, and pointing it at a Worker changes the disposition of every
  // unmatched message to the domain. Before doing that, show what is already
  // routed — an operator should be able to read this list and see that their own
  // mail is not in the blast radius.
  step("4. Existing routing rules");
  const rules = await cf(`/zones/${zone.id}/email/routing/rules?per_page=200`);
  if (!rules.ok) {
    stop(
      `Could not list routing rules (HTTP ${rules.status}). ${JSON.stringify(rules.body.errors ?? {})}\n`
        + "     Refusing to touch the catch-all without knowing what it sits underneath.",
    );
    return;
  }

  // Cloudflare matches the recipient against the configured rules first, and
  // only falls through to the catch-all when none of them matched
  // (developers.cloudflare.com/email-service/concepts/email-lifecycle/). So an
  // enabled literal rule is strictly ahead of the catch-all and cannot be
  // shadowed by it. That is the property this step exists to make visible.
  const literal = (rules.body.result ?? []).filter((r) =>
    (r.matchers ?? []).every((m) => m.type !== "all")
  );
  if (literal.length === 0) {
    info("No literal address rules. Every message to this domain is currently unmatched.");
  } else {
    for (const r of literal) {
      const to = (r.matchers ?? []).map((m) => m.value).join(", ");
      const act = (r.actions ?? []).map((a) => `${a.type}${a.value ? ` → ${[a.value].flat().join(", ")}` : ""}`).join("; ");
      info(`${r.enabled ? "active " : "paused "} ${to}  ${act}`);
    }
    ok(
      `${literal.length} address rule(s) match before the catch-all and are unaffected by step 5.`,
    );
  }

  // Guard against the abandoned design reappearing. Nothing should be creating
  // this name; if it exists, something did, and that needs a human before any
  // further change to the zone's mail path.
  const strayMx = await cf(
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(`agents.${ZONE_NAME}`)}`,
  );
  if (strayMx.ok && (strayMx.body.result ?? []).length > 0) {
    stop(
      `agents.${ZONE_NAME} has DNS records, and the seat design does not use that name.\n`
        + "     Seats are agent-{orgSlug}@ on the apex. Resolve this by hand before continuing.",
    );
    return;
  }
  info(`Address format: ${ADDRESS_FORMAT}`);

  // ── 5. catch-all → Worker ──────────────────────────────────────────────────
  step("5. Pointing the catch-all at the seat Worker");
  // There is no wildcard local-part rule in Email Routing — literal addresses or
  // the catch-all, nothing in between. Seats are created per customer without a
  // Cloudflare write, so the catch-all is the only mechanism that can deliver
  // them, and the Worker itself does the narrowing: worker/pms-seat-inbound.ts
  // accepts agent-{orgSlug}@ and rejects everything else back to the sender.
  const rule = {
    enabled: true,
    name: "Aval PMS seat inbound",
    matchers: [{ type: "all" }],
    actions: [{ type: "worker", value: [WORKER_NAME] }],
  };
  const currentCatchAll = await cf(`/zones/${zone.id}/email/routing/rules/catch_all`);
  if (currentCatchAll.ok) {
    const a = (currentCatchAll.body.result?.actions ?? [])[0];
    info(
      `Currently: ${currentCatchAll.body.result?.enabled ? "enabled" : "disabled"}, action `
        + `${a?.type ?? "none"}${a?.value ? ` → ${[a.value].flat().join(", ")}` : ""}`,
    );
  }
  if (!APPLY) {
    info(`Would PUT /zones/${zone.id}/email/routing/rules/catch_all → worker "${WORKER_NAME}" (dry run).`);
  } else {
    const catchAll = await cf(`/zones/${zone.id}/email/routing/rules/catch_all`, {
      method: "PUT",
      body: JSON.stringify(rule),
    });
    if (!catchAll.ok) {
      stop(
        `Could not set the catch-all (HTTP ${catchAll.status}). ${JSON.stringify(catchAll.body.errors ?? {})}\n`
          + `     If this says the worker does not exist, deploy worker/pms-seat-inbound.ts as "${WORKER_NAME}" first:\n`
          + "     npx wrangler deploy --config wrangler.seat.jsonc",
      );
      return;
    }
    ok(`Catch-all routed to "${WORKER_NAME}"`);
  }

  // ── 6. anti-spoofing position ──────────────────────────────────────────────
  step("6. Anti-spoofing (SPF / DMARC)");
  // SPF and DMARC scope to a domain, never to a local-part. Seats are
  // agent-{orgSlug}@aval.llc, so the only name that could carry a receive-only
  // assertion is the apex — and the apex sends real mail (Cloudflare forwarding,
  // plus Resend and SES on send.aval.llc). Publishing "-all" there would fail
  // every legitimate message the company sends.
  //
  // So there is no record to write, and this step writes none. That is not a
  // silent gap: it is the accepted cost of the apex-prefix format, stated here
  // so it is chosen rather than discovered. A seat address has no record saying
  // it never sends, which means a spoofed agent-{orgSlug}@aval.llc reaching a
  // customer's PMS is defended by DMARC on the apex (currently p=none) and by
  // the customer's own filters, not by anything specific to the seat.
  //
  // The real mitigation is inbound, and it is P1: the Worker stores every
  // message unparsed until SPF/DKIM/DMARC alignment is checked against a
  // per-org allowlist. Aval never acts on seat mail it has not authenticated,
  // which is the property that matters. Nothing here should read as a substitute.
  info(`${ZONE_NAME} sends mail, so no receive-only assertion can be published for the seats.`);
  info("Accepted limitation of the apex-prefix format. Inbound verification (P1) is the mitigation.");
  const dmarc = await cf(
    `/zones/${zone.id}/dns_records?type=TXT&name=${encodeURIComponent(`_dmarc.${ZONE_NAME}`)}`,
  );
  if (dmarc.ok) {
    const policy = /p=(\w+)/.exec((dmarc.body.result ?? [])[0]?.content ?? "")?.[1];
    if (policy && policy !== "none") ok(`Apex DMARC is p=${policy}.`);
    else if (policy === "none") {
      info("Apex DMARC is p=none — it reports spoofing but does not stop it. Worth tightening separately.");
    }
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Address format: ${ADDRESS_FORMAT}`);
  console.log(`Worker route:   catch_all on ${ZONE_NAME} → ${WORKER_NAME}`);
  console.log(`Preserved:      ${literal.length} literal address rule(s), matched ahead of the catch-all`);
  console.log(`Mode:           ${APPLY ? "APPLIED" : "DRY RUN — re-run with --apply"}`);
  console.log(
    "\nNext: send a test message to an address in that format and confirm it lands in R2\n"
      + "under unverified/<recipient>/<sha256>. Inbound sender verification is P1 —\n"
      + "until it ships, stored mail is never parsed.",
  );
}

await main();
process.exit(failed ? 1 : 0);
