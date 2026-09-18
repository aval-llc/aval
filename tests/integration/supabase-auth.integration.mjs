import assert from "node:assert/strict";
import test from "node:test";

import {
  requestSupabasePasswordReset,
  resendSupabaseSignupVerification,
  signInWithSupabasePassword,
  SupabaseAuthError,
  updateSupabasePassword,
  verifySupabaseRecoveryToken,
} from "../../lib/auth/supabase.ts";

const bindings = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "test-key" };
const verifiedSession = () => ({
  access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600,
  user: { id: "user-1", email: "person@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" },
});

test("Supabase Auth uses the redirect mode supported by Cloudflare Workers", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://project.supabase.co/auth/v1/token?grant_type=password");
    assert.equal(init.redirect, "manual");
    return Response.json({ message: "Invalid login credentials" }, { status: 400 });
  });

  await assert.rejects(
    signInWithSupabasePassword(
      new Request("https://app.aval.llc/api/auth/login"),
      bindings,
      "person@example.com",
      "invalid",
    ),
    (error) => error instanceof SupabaseAuthError && error.status === 400,
  );
});

test("password recovery and signup resend use fixed same-origin redirects", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({});
  });
  await requestSupabasePasswordReset(bindings, "person@example.com", "https://app.aval.llc/api/auth/confirm?next=%2Fen");
  await resendSupabaseSignupVerification(bindings, "person@example.com", "https://app.aval.llc/en");
  assert.match(seen[0].url, /\/recover\?redirect_to=https%3A%2F%2Fapp\.aval\.llc%2Fapi%2Fauth%2Fconfirm/);
  assert.deepEqual(seen[0].body, { email: "person@example.com", gotrue_meta_security: {} });
  assert.match(seen[1].url, /\/resend\?redirect_to=https%3A%2F%2Fapp\.aval\.llc%2Fen/);
  assert.deepEqual(seen[1].body, { type: "signup", email: "person@example.com", gotrue_meta_security: {} });
});

test("one-time recovery verification establishes HttpOnly cookies and rejects reuse", async (t) => {
  let attempt = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://project.supabase.co/auth/v1/verify");
    assert.deepEqual(JSON.parse(init.body), { token_hash: "token-hash", type: "recovery", gotrue_meta_security: {} });
    return attempt++ === 0 ? Response.json(verifiedSession()) : Response.json({ message: "Token has expired" }, { status: 403 });
  });
  const request = new Request("https://app.aval.llc/api/auth/confirm");
  const result = await verifySupabaseRecoveryToken(request, bindings, "token-hash");
  assert.equal(result.identity.userId, "user-1");
  assert.equal(result.cookies.length, 2);
  assert.ok(result.cookies.every(cookie => cookie.includes("HttpOnly") && cookie.includes("Secure") && cookie.includes("SameSite=Lax")));
  await assert.rejects(verifySupabaseRecoveryToken(request, bindings, "token-hash"), error =>
    error instanceof SupabaseAuthError && error.status === 403);
});

test("password update validates the current session and uses its access token", async (t) => {
  let call = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    call++;
    assert.equal(url, "https://project.supabase.co/auth/v1/user");
    assert.equal(init.headers.authorization, "Bearer existing-access");
    if (init.method === "PUT") {
      assert.deepEqual(JSON.parse(init.body), { password: "long-enough-password" });
      return Response.json({ user: verifiedSession().user });
    }
    return Response.json(verifiedSession().user);
  });
  const request = new Request("https://app.aval.llc/api/auth/update-password", { headers: { cookie: "aval-sb-access=existing-access" } });
  assert.deepEqual(await updateSupabasePassword(request, bindings, "long-enough-password"), []);
  assert.equal(call, 2);
});

test("password update fails closed without a valid session", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "invalid" }, { status: 401 }));
  await assert.rejects(
    updateSupabasePassword(new Request("https://app.aval.llc/api/auth/update-password"), bindings, "long-enough-password"),
    error => error instanceof SupabaseAuthError && error.status === 401,
  );
});
