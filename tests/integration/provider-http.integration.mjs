import assert from "node:assert/strict";
import test from "node:test";
import { providerJson, ProviderHttpError } from "../../lib/integrations/http.ts";
import { requestOAuthToken } from "../../lib/integrations/oauth.ts";
import { verifyAdditionalCredentials, verifyOAuthReadAccess } from "../../lib/integrations/verification.ts";
import { dispatchMessage } from "../../lib/communications/providers.ts";

test("Workers-compatible manual redirects reject credential forwarding", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    assert.equal(init.redirect, "manual", "Workers must never receive redirect:error or follow");
    return new Response('private provider body', { status: 302, headers: { location: 'https://untrusted.test' } });
  });
  await assert.rejects(providerJson('https://provider.test', { headers: { authorization: 'Bearer fixture' } }),
    error => error instanceof ProviderHttpError && error.status === 302 && !error.retryable && !error.message.includes('private'));
  await assert.rejects(dispatchMessage({ provider: 'outlook', to: 'fixture@example.test', body: 'Fixture' },
    { accessToken: 'fixture' }, {}, 'fixture-operation'), /302/);
  assert.equal(calls, 2, 'no request is made to the redirect destination');
});

test("Outlook accepts its bodyless 202 response", async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 202 });
  });
  assert.deepEqual(await dispatchMessage({ provider: 'outlook', to: 'fixture@example.test', body: 'Fixture' },
    { accessToken: 'fixture' }, {}, 'fixture-operation'), { id: null, status: 'accepted' });
});

test("provider HTTP rejects redirects, oversized bodies, malformed JSON, and API-level errors", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.redirect, "manual");
    return new Response("x".repeat(2_000_001));
  });
  await assert.rejects(providerJson("https://provider.test"), /safe page size/);
  for (const value of ["invalid json", '{"ok":false}', '{"error":"private-token"}']) {
    globalThis.fetch.mock.mockImplementation(async () => new Response(value));
    await assert.rejects(providerJson("https://provider.test"), error => !error.message.includes("private-token"));
  }
  await assert.rejects(providerJson("http://provider.test"), /Invalid provider endpoint/);
  await assert.rejects(providerJson("https://user:pass@provider.test"), /Invalid provider endpoint/);
});
test("rate limits preserve bounded retry timing without reflecting provider bodies", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "secret" }, { status: 429, headers: { "retry-after": "99999" } }));
  await assert.rejects(providerJson("https://provider.test"), error => error instanceof ProviderHttpError && error.retryable && error.retryAfterSeconds === 3600 && !error.message.includes("secret"));
});
test("OAuth rejects partial consent and malformed token fields", async (t) => {
  const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "token", scope: "openid email" }));
  await assert.rejects(requestOAuthToken("google_drive", env, { grant_type: "authorization_code", code: "test" }), /permissions were not granted/);
  for (const value of [{ access_token: 9 }, { access_token: "token", refresh_token: {} }, { access_token: "token", expires_in: -1 }]) {
    globalThis.fetch.mock.mockImplementation(async () => Response.json(value));
    await assert.rejects(requestOAuthToken("google_drive", env, { grant_type: "authorization_code", code: "test" }));
  }
});
test("provider verification rejects injected hosts and mismatched authorized account ids", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ location: { id: "other", name: "Other" } }); });
  await assert.rejects(verifyAdditionalCredentials("rentvine", { subdomain: "account.rentvine.com@evil.test" }, {}), /subdomain/);
  assert.equal(calls, 0);
  await assert.rejects(verifyAdditionalCredentials("gohighlevel", { apiKey: "test", locationId: "expected" }, {}), /different location/);
  await assert.rejects(verifyAdditionalCredentials("meta", { accessToken: "test", pageId: "1" }, { META_GRAPH_API_VERSION: "../me" }), /valid Meta/);
});
test("OAuth product probes accept empty collections but reject missing product permissions", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("chat.googleapis.com")) return Response.json({});
    if (url.includes("googleapis.com/drive")) return Response.json({ files: [] });
    if (url.includes("graph.microsoft.com")) return Response.json({ value: [] });
    if (url.includes("api.box.com")) return Response.json({ entries: [] });
    throw new Error("Unexpected endpoint");
  });
  for (const provider of ["google_chat", "google_drive", "google_sheets", "microsoft_teams", "onedrive", "box"]) await verifyOAuthReadAccess(provider, "test");
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ error: "forbidden" }, { status: 403 }));
  await assert.rejects(verifyOAuthReadAccess("google_sheets", "test"), /permission/);
});
