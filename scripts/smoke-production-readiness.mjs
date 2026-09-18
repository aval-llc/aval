#!/usr/bin/env node

/**
 * Provider-free production smoke. It proves the deployed application can
 * authenticate, read workspace-scoped integration state, and read agent
 * health without spending model credits or creating durable work.
 */
import { readFileSync } from "node:fs";

const baseUrl = (process.argv[2] ?? process.env.AVAL_PRODUCTION_URL ?? "").replace(/\/$/, "");
if (!/^https:\/\//.test(baseUrl)) fail("Pass an HTTPS production URL", {});

const prepared = process.env.AVAL_SMOKE_CREDENTIALS_FILE
  ? JSON.parse(readFileSync(process.env.AVAL_SMOKE_CREDENTIALS_FILE, "utf8"))
  : {};
const email = process.env.AVAL_SMOKE_EMAIL || prepared.email;
const password = process.env.AVAL_SMOKE_PASSWORD || prepared.password;
if (!email || !password) fail("Production verification credentials are missing", {});

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
if (!login.ok || !sessionCookie) {
  const raw = await login.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { nonJsonBody: raw.slice(0, 300) }; }
  fail(`Verification account login failed (${login.status})`, {
    body,
    contentType: login.headers.get("content-type"),
    server: login.headers.get("server"),
    cfRay: login.headers.get("cf-ray"),
  });
}

const integrations = await request("/api/integrations");
if (integrations.status !== 200 || !Array.isArray(integrations.body?.providers) || integrations.body?.storage === "unavailable") {
  fail(`Integration readiness failed (${integrations.status})`, integrations.body);
}

const health = await request("/api/agents/health");
if (health.status !== 200 || health.body?.scope !== "workspace" || typeof health.body?.status !== "string") {
  fail(`Workspace agent health failed (${health.status})`, health.body);
}

console.log(JSON.stringify({
  ok: true,
  authentication: "ready",
  integrations: "readable",
  agentHealth: health.body.status,
  connectedModelSelected: typeof integrations.body.activeModelProvider === "string",
}));

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: sessionCookie } });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { nonJsonBody: raw.slice(0, 300) }; }
  return { status: response.status, body };
}

function fail(message, detail) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}
