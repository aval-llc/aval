import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { bootRuntime } from "./harness.mjs";

// Next's package has no ESM subpath export for headers; keep its real module.
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "next/headers" ? "next/headers.js" : specifier, context);
} });

/**
 * /api/pms/seat — the surface that makes the seat usable at all.
 *
 * Before it, a slug could be claimed and a sender allowed only from a test, and
 * `verifySender` refuses every message until a workspace has allowed a domain.
 * So these assertions are mostly about consent: who may grant it, what a grant
 * covers, and what the response is allowed to name.
 */

const NOW = Date.now();

async function setup() {
  const sqlite = await bootRuntime();
  const { env } = await import("cloudflare:workers");
  env.DB = {
    prepare(sql) {
      return { bind(...params) {
        return {
          first: async () => sqlite.prepare(sql).get(...params) ?? null,
          all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
          run: async () => sqlite.prepare(sql).run(...params),
        };
      } };
    },
  };
  const route = await import("../../app/api/pms/seat/route.ts");
  return { sqlite, route };
}

/** The owner of their own workspace, which `ensureOrganization` creates on first call. */
function request(user, body) {
  return new Request("https://aval.test/api/pms/seat", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(user ? { "oai-authenticated-user-id": user, "oai-authenticated-user-email": `${user}@example.test` } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response) {
  return response.json();
}

test("an unauthenticated caller gets nothing", async () => {
  const { route } = await setup();
  assert.equal((await route.GET(request(null))).status, 401);
  assert.equal((await route.POST(request(null, { intent: "claim", slug: "acme" }))).status, 401);
});

test("a workspace with no seat is told so, and nothing is being read", async () => {
  const { route } = await setup();
  const body = await json(await route.GET(request("alice")));
  assert.equal(body.address, null);
  assert.deepEqual(body.allowlist, []);
  // The state that matters: no allowed sender means verifySender refuses
  // everything, and the panel says as much rather than looking configured.
  assert.deepEqual(body.review.held, []);
  assert.equal(body.review.verified, 0);
  assert.equal(body.canEdit, true, "the workspace owner can change it");
});

test("claiming an address returns the address a customer types into their PMS", async () => {
  const { route } = await setup();
  const claimed = await json(await route.POST(request("alice", { intent: "claim", slug: "acme-props" })));
  assert.equal(claimed.address, "agent-acme-props@aval.llc");
  assert.equal(claimed.alias, false);
  assert.equal((await json(await route.GET(request("alice")))).address, "agent-acme-props@aval.llc");
});

test("renaming keeps the old address listed as still receiving", async () => {
  const { route } = await setup();
  await route.POST(request("alice", { intent: "claim", slug: "acme-props" }));
  await route.POST(request("alice", { intent: "claim", slug: "acme-residential" }));

  const body = await json(await route.GET(request("alice")));
  assert.equal(body.address, "agent-acme-residential@aval.llc");
  // The customer's PMS may still have the first one on file, and it still works.
  assert.deepEqual(body.addresses.sort(), [
    "agent-acme-props@aval.llc",
    "agent-acme-residential@aval.llc",
  ]);
});

test("a slug another workspace holds cannot be taken, and the refusal names nobody", async () => {
  const { route } = await setup();
  await route.POST(request("alice", { intent: "claim", slug: "acme-props" }));

  const stolen = await route.POST(request("bob", { intent: "claim", slug: "acme-props" }));
  assert.equal(stolen.status, 422);
  const body = await json(stolen);
  // A setup field must not be an enumeration oracle for other workspaces.
  assert.doesNotMatch(body.error, /alice|acme-props/i);
  assert.equal((await json(await route.GET(request("alice")))).address, "agent-acme-props@aval.llc");
});

test("allowing a sender records it, scoped to the workspace that allowed it", async () => {
  const { route } = await setup();
  await route.POST(request("alice", { intent: "claim", slug: "acme-props" }));

  const allowed = await json(await route.POST(request("alice", {
    intent: "allow",
    domain: "https://MAIL.appfolio.com/x",
    providerId: "appfolio",
  })));
  // Normalized on the way in, so two spellings of one domain are one grant.
  assert.equal(allowed.domain, "mail.appfolio.com");
  assert.equal(allowed.pendingSweep, true, "held mail is released by the sweep, not by this request");

  const alice = await json(await route.GET(request("alice")));
  assert.equal(alice.allowlist.length, 1);
  assert.equal(alice.allowlist[0].displayName, "AppFolio");

  // Bob's workspace is untouched by Alice's consent.
  assert.deepEqual((await json(await route.GET(request("bob")))).allowlist, []);
});

test("a domain the rules refuse is rejected with a sentence, not stored", async () => {
  const { route } = await setup();
  for (const domain of ["gmail.com", "aval.llc", "co.uk", "com"]) {
    const response = await route.POST(request("alice", { intent: "allow", domain, providerId: "generic_email" }));
    assert.equal(response.status, 422, `${domain} should be refused`);
    const body = await json(response);
    assert.match(body.error, /[.!]$/, `${domain}'s refusal should read as a sentence`);
  }
  assert.deepEqual((await json(await route.GET(request("alice")))).allowlist, []);
});

test("revoking removes the grant, and revoking nothing is not an error", async () => {
  const { route } = await setup();
  await route.POST(request("alice", { intent: "allow", domain: "appfolio.com", providerId: "appfolio" }));

  assert.equal((await json(await route.POST(request("alice", { intent: "revoke", domain: "appfolio.com" })))).revoked, true);
  assert.deepEqual((await json(await route.GET(request("alice")))).allowlist, []);
  assert.equal((await json(await route.POST(request("alice", { intent: "revoke", domain: "appfolio.com" })))).revoked, false);
});

test("generic_email is always offerable, so a PMS nobody integrated can still use the seat", async () => {
  const { route } = await setup();
  const body = await json(await route.GET(request("alice")));
  // Nothing is connected in this workspace, and the picker still has an option.
  assert.ok(body.providers.some((choice) => choice.id === "generic_email"));
  const allowed = await route.POST(request("alice", {
    intent: "allow",
    domain: "notices.a-small-pm-company.example",
    providerId: "generic_email",
  }));
  assert.equal(allowed.status, 200);
});

test("the review names authenticated senders and only counts the rest", async () => {
  const { sqlite, route } = await setup();
  await route.POST(request("alice", { intent: "claim", slug: "acme-props" }));
  const organizationId = sqlite.prepare("SELECT organization_id FROM organization_seat_slugs").get().organization_id;

  const row = (digest, disposition, domain) =>
    sqlite
      .prepare(
        "INSERT INTO pms_seat_messages (digest,recipient,organization_id,disposition,authenticated_domain,method,object_key,received_at,processed_at)"
        + " VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(digest, "agent-acme-props@aval.llc", organizationId, disposition, domain, domain ? "dmarc" : null, `k/${digest}`, NOW, NOW);

  row("d1", "held", "buildium.com");
  row("d2", "held", "buildium.com");
  // An unauthenticated message has no authenticated domain by construction, so
  // there is nothing here the response could name even by mistake.
  row("d3", "unauthenticated", null);
  row("d4", "verified", "appfolio.com");

  const body = await json(await route.GET(request("alice")));
  assert.equal(body.review.held.length, 1);
  assert.equal(body.review.held[0].domain, "buildium.com");
  assert.equal(body.review.held[0].messages, 2);
  assert.equal(body.review.unauthenticated.messages, 1);
  assert.equal(body.review.verified, 1);

  // Structural, not a string search: the unauthenticated summary has no field a
  // sender's text could arrive in. A count and a timestamp, and nothing else.
  assert.deepEqual(Object.keys(body.review.unauthenticated).sort(), ["lastSeen", "messages"]);
});

test("an unknown intent changes nothing", async () => {
  const { route } = await setup();
  const response = await route.POST(request("alice", { intent: "allow_everything" }));
  assert.equal(response.status, 400);
  assert.deepEqual((await json(await route.GET(request("alice")))).allowlist, []);
});

test("malformed JSON is refused before anything is read", async () => {
  const { route } = await setup();
  const response = await route.POST(new Request("https://aval.test/api/pms/seat", {
    method: "POST",
    headers: { "oai-authenticated-user-id": "alice", "oai-authenticated-user-email": "alice@example.test", "content-type": "application/json" },
    body: "{not json",
  }));
  assert.equal(response.status, 400);
});
