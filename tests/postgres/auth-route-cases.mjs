import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { env } from "cloudflare:workers";
import { POST as forgotPassword } from "../../app/api/auth/forgot-password/route.ts";
import { POST as resendVerification } from "../../app/api/auth/resend-verification/route.ts";
import { GET as confirmRecovery } from "../../app/api/auth/confirm/route.ts";
import { POST as updatePassword } from "../../app/api/auth/update-password/route.ts";
import { withVerifiedIdentityHeaders } from "../../lib/auth/request-identity.ts";

const jsonRequest = (path, body, headers = new Headers()) => {
  headers.set("content-type", "application/json");
  return new Request(`https://app.aval.llc${path}`, { method: "POST", headers, body: JSON.stringify(body) });
};

export async function runAuthRouteCases(t, { config }) {
  const previousEnv = { ...env };
  env.DATABASE_URL = config.connectionString;
  env.SUPABASE_URL = "https://project.supabase.co";
  env.SUPABASE_ANON_KEY = "test-key";
  delete env.HYPERDRIVE;
  try {
    await t.test("password reset is rate limited without revealing account existence", async subtest => {
      let requests = 0;
      subtest.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ message: "User not found" }, { status: 400 }); });
      assert.equal((await forgotPassword(jsonRequest("/api/auth/forgot-password", { email: "bad" }))).status, 400);
      const email = `${randomUUID()}@example.test`;
      for (let i = 0; i < 5; i++) {
        const response = await forgotPassword(jsonRequest("/api/auth/forgot-password", { email }, new Headers({ "cf-connecting-ip": "192.0.2.1" })));
        assert.equal(response.status, 200);
        assert.match((await response.json()).message, /If an account exists/);
      }
      assert.equal((await forgotPassword(jsonRequest("/api/auth/forgot-password", { email }, new Headers({ "cf-connecting-ip": "192.0.2.1" })))).status, 429);
      assert.equal(requests, 5);
    });
    await t.test("verification resend has a generic response", async subtest => {
      subtest.mock.method(globalThis, "fetch", async () => Response.json({ message: "already confirmed" }, { status: 400 }));
      const response = await resendVerification(jsonRequest("/api/auth/resend-verification", { email: `${randomUUID()}@example.test` }));
      assert.equal(response.status, 200);
      assert.match((await response.json()).message, /still needs verification/);
    });
    await t.test("recovery confirmation rejects malformed links and sets a server session for valid tokens", async subtest => {
      assert.equal((await confirmRecovery(new Request("https://app.aval.llc/api/auth/confirm?type=signup"))).status, 303);
      subtest.mock.method(globalThis, "fetch", async () => Response.json({
        access_token: "access", refresh_token: "refresh", expires_in: 3600,
        user: { id: "recovery-user", email: "recovery@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" },
      }));
      const response = await confirmRecovery(new Request("https://app.aval.llc/api/auth/confirm?token_hash=valid&type=recovery&next=%2Fen%3Frecovery%3D1"));
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "https://app.aval.llc/en?recovery=1");
      assert.match(response.headers.get("set-cookie"), /HttpOnly/);
      const external = await confirmRecovery(new Request("https://app.aval.llc/api/auth/confirm?token_hash=valid&type=recovery&next=https%3A%2F%2Fevil.example"));
      assert.equal(external.headers.get("location"), "https://app.aval.llc/en?recovery=1");
    });
    await t.test("password update requires Aval's verified request identity", async subtest => {
      assert.equal((await updatePassword(jsonRequest("/api/auth/update-password", { password: "new-password" }))).status, 401);
      const identity = { userId: "recovery-user", email: "recovery@example.test", displayName: "Recovery", emailVerified: true };
      const headers = withVerifiedIdentityHeaders(new Headers({ cookie: "aval-sb-access=access" }), identity);
      let calls = 0;
      subtest.mock.method(globalThis, "fetch", async (_url, init) => {
        calls++;
        return init.method === "PUT" ? Response.json({}) : Response.json({ id: identity.userId, email: identity.email, email_confirmed_at: "2026-01-01T00:00:00Z" });
      });
      assert.equal((await updatePassword(jsonRequest("/api/auth/update-password", { password: "short" }, headers))).status, 400);
      assert.equal((await updatePassword(jsonRequest("/api/auth/update-password", { password: "long-enough-password" }, headers))).status, 200);
      assert.equal(calls, 2);
    });
  } finally {
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, previousEnv);
  }
}
