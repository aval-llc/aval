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
 *   3. enable Email Routing, and find out whether this zone supports it on the
 *      agents.aval.llc subdomain
 *   4. point the catch-all at the seat Worker
 *   5. assert this subdomain never sends: SPF -all and DMARC p=reject
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
const SUBDOMAIN = process.env.PMS_SEAT_SUBDOMAIN ?? "agents";
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

  // Cloudflare Email Routing is configured per zone. Subdomain support is a
  // zone-level capability that is not reliably reported by the API, so this
  // probes for it and falls back rather than fighting it.
  step(`4. Address scheme`);
  const subdomainZone = `${SUBDOMAIN}.${ZONE_NAME}`;

  // Two different Cloudflare features share the word "subdomain", and this
  // originally probed for the wrong one:
  //
  //   * DNS *subdomain setup* — the subdomain as a standalone zone. Enterprise
  //     only (Free/Pro/Business: No), so on this account it is never true and
  //     probing for it silently forced the apex-prefix path forever.
  //   * Email Routing *subdomains* — an ordinary subdomain of the SAME zone,
  //     enabled under Email Routing → Settings → Subdomains. Available on every
  //     plan, up to 30 domains per zone, and it is what we actually need: it
  //     gives `{orgSlug}@agents.aval.llc` a name of its own to carry the
  //     receive-only assertion, while the apex keeps its real sending records.
  //
  // Enabling it is a dashboard action (and needs the Email Routing settings
  // scope this token lacks), so this detects rather than creates it — by the
  // MX records Cloudflare publishes on the subdomain when it is enabled, which
  // the DNS scope can read.
  const subMx = await cf(`/zones/${zone.id}/dns_records?type=MX&name=${encodeURIComponent(subdomainZone)}`);
  if (!subMx.ok) {
    stop(
      `Could not determine whether Email Routing is enabled on ${subdomainZone} (HTTP ${subMx.status}).\n`
        + "     This choice fixes the address format for every customer, so it is not defaulted from a failed read.",
    );
    return;
  }
  const subdomainSupported = (subMx.body.result ?? []).some((r) =>
    /\.mx\.cloudflare\.net\.?$/i.test(r.content ?? "")
  );

  const path = subdomainSupported ? "subdomain" : "apex-prefix";
  const addressFormat = subdomainSupported ? `{orgSlug}@${subdomainZone}` : `agent-{orgSlug}@${ZONE_NAME}`;

  if (subdomainSupported) {
    ok(`Email Routing is enabled on ${subdomainZone} — seats get their own name.`);
  } else {
    info(
      `Email Routing is not enabled on ${subdomainZone}, so seats would sit on the apex with a reserved prefix.\n`
        + "     Delivery is equivalent, but the two paths are NOT interchangeable: only a subdomain can carry\n"
        + "     the receive-only SPF/DMARC assertion in step 6. See there.\n"
        + `     Enable it: Cloudflare dashboard → ${ZONE_NAME} → Compute → Email Service → Email Routing →\n`
        + `     Settings → Subdomains → add "${SUBDOMAIN}".`,
    );
  }
  info(`Address format: ${addressFormat}`);

  // ── 5. catch-all → Worker ──────────────────────────────────────────────────
  step("5. Pointing the catch-all at the seat Worker");
  const rule = {
    enabled: true,
    name: "Aval PMS seat inbound",
    matchers: [{ type: "all" }],
    actions: [{ type: "worker", value: [WORKER_NAME] }],
  };
  // The catch_all endpoint is the APEX's catch-all. On the subdomain path that
  // is the wrong target and an actively harmful one: it would route every
  // unmatched `@aval.llc` message into the PMS seat Worker, which has nothing to
  // do with the seats and would quietly swallow ordinary company mail. Routing
  // rules are per domain (up to 30 per zone), so the subdomain needs its own
  // rule — and confirming that endpoint needs the Email Routing settings scope
  // this token does not have. Stop rather than PUT the apex by default.
  if (path === "subdomain") {
    stop(
      `Refusing to set the apex catch-all while seats live at ${subdomainZone}.\n`
        + `     It would route every unmatched ${ZONE_NAME} message into "${WORKER_NAME}".\n`
        + `     Point ${subdomainZone}'s own catch-all at the Worker instead: dashboard → Email Routing →\n`
        + `     select ${subdomainZone} → Routing Rules → Catch-all → Send to a Worker.`,
    );
  } else if (!APPLY) {
    info(`Would PUT /zones/${zone.id}/email/routing/rules/catch_all → worker "${WORKER_NAME}" (dry run).`);
  } else {
    const catchAll = await cf(`/zones/${zone.id}/email/routing/rules/catch_all`, {
      method: "PUT",
      body: JSON.stringify(rule),
    });
    if (!catchAll.ok) {
      stop(
        `Could not set the catch-all (HTTP ${catchAll.status}). ${JSON.stringify(catchAll.body.errors ?? {})}\n`
          + `     If this says the worker does not exist, deploy worker/pms-seat-inbound.ts as "${WORKER_NAME}" first.`,
      );
      return;
    }
    ok(`Catch-all routed to "${WORKER_NAME}"`);
  }

  // ── 6. assert this subdomain never sends ───────────────────────────────────
  step("6. SPF and DMARC (receive-only assertions)");
  // These addresses only ever receive. Publishing "-all" and "p=reject" says so
  // in the only place a receiving mail server will look, which is what stops
  // someone spoofing a seat address to a customer's PMS.
  //
  // SPF and DMARC scope to a domain, never to a local-part. On the apex-prefix
  // path the seats are agent-{orgSlug}@ZONE, so the only name that could carry
  // the assertion is the apex \u2014 which sends real mail, and would fail every
  // legitimate message if it published "-all". Writing to SUBDOMAIN instead
  // publishes on a name no receiving server consults for these addresses: a
  // green check protecting nothing. Neither is acceptable, so the gap is
  // reported rather than papered over.
  const records = path === "subdomain"
    ? [
      { type: "TXT", name: SUBDOMAIN, content: "v=spf1 -all" },
      { type: "TXT", name: `_dmarc.${SUBDOMAIN}`, content: "v=DMARC1; p=reject;" },
    ]
    : [];
  if (path !== "subdomain") {
    stop(
      `Cannot assert receive-only for ${addressFormat}.\n`
        + `     SPF/DMARC apply per domain, not per local-part, and ${ZONE_NAME} sends real mail.\n`
        + `     Enable Email Routing on ${subdomainZone} (dashboard → Email Routing → Settings →\n`
        + `     Subdomains → add "${SUBDOMAIN}") and re-run to get the assertion, or accept that seat\n`
        + "     addresses carry no anti-spoofing record and record that decision.",
    );
  }

  for (const record of records) {
    const fqdn = `${record.name}.${ZONE_NAME}`;
    const existing = await cf(`/zones/${zone.id}/dns_records?type=TXT&name=${encodeURIComponent(fqdn)}`);
    const current = existing.ok ? (existing.body.result ?? [])[0] : null;

    if (current && current.content.replace(/"/g, "") === record.content) {
      ok(`${fqdn} already correct`);
      continue;
    }
    if (!APPLY) {
      info(`Would ${current ? "update" : "create"} TXT ${fqdn} = "${record.content}" (dry run).`);
      continue;
    }
    const written = current
      ? await cf(`/zones/${zone.id}/dns_records/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: record.content }),
      })
      : await cf(`/zones/${zone.id}/dns_records`, { method: "POST", body: JSON.stringify({ ...record, ttl: 1 }) });

    if (!written.ok) {
      stop(`Could not write TXT ${fqdn} (HTTP ${written.status}). ${JSON.stringify(written.body.errors ?? {})}`);
      continue;
    }
    ok(`${fqdn} = "${record.content}"`);
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Path taken:     ${path}`);
  console.log(`Address format: ${addressFormat}`);
  console.log(
    `Worker route:   ${path === "subdomain" ? `catch_all on ${subdomainZone} (set by hand)` : `catch_all on ${ZONE_NAME}`} → ${WORKER_NAME}`,
  );
  console.log(`Mode:           ${APPLY ? "APPLIED" : "DRY RUN — re-run with --apply"}`);
  console.log(
    "\nNext: send a test message to an address in that format and confirm it lands in R2\n"
      + "under unverified/<recipient>/<sha256>. Inbound sender verification is P1 —\n"
      + "until it ships, stored mail is never parsed.",
  );
}

await main();
process.exit(failed ? 1 : 0);
