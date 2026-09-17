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
  const routing = await cf(`/zones/${zone.id}/email/routing`);
  const enabled = routing.ok && routing.body.result?.enabled === true;
  info(`Currently ${enabled ? "enabled" : "not enabled"}`);

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
  const subZones = await cf(`/zones?name=${encodeURIComponent(subdomainZone)}`);
  const subdomainSupported = subZones.ok && (subZones.body.result ?? []).length > 0;

  const path = subdomainSupported ? "subdomain" : "apex-prefix";
  const addressFormat = subdomainSupported ? `{orgSlug}@${subdomainZone}` : `agent-{orgSlug}@${ZONE_NAME}`;

  if (subdomainSupported) {
    ok(`${subdomainZone} exists as its own zone — configuring Email Routing there.`);
  } else {
    ok(
      `${subdomainZone} is not a separate zone, so Email Routing runs on the apex with a reserved prefix.\n`
        + "     Functionally identical; not worth fighting.",
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
  const records = [
    { type: "TXT", name: SUBDOMAIN, content: "v=spf1 -all" },
    { type: "TXT", name: `_dmarc.${SUBDOMAIN}`, content: "v=DMARC1; p=reject;" },
  ];

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
  console.log(`Worker route:   catch_all on ${ZONE_NAME} → ${WORKER_NAME}`);
  console.log(`Mode:           ${APPLY ? "APPLIED" : "DRY RUN — re-run with --apply"}`);
  console.log(
    "\nNext: send a test message to an address in that format and confirm it lands in R2\n"
      + "under unverified/<recipient>/<sha256>. Inbound sender verification is P1 —\n"
      + "until it ships, stored mail is never parsed.",
  );
}

await main();
process.exit(failed ? 1 : 0);
