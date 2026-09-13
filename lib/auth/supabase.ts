/** Server-side Supabase Auth transport for the Cloudflare Worker. */

export interface SupabaseAuthBindings {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
}

export interface SupabaseUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  user_metadata?: Record<string, unknown>;
}

interface SupabaseSessionPayload {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: SupabaseUser;
}

export interface VerifiedSupabaseIdentity {
  userId: string;
  email: string;
  displayName: string;
  emailVerified: true;
}

export interface RequestAuthentication {
  identity: VerifiedSupabaseIdentity;
  responseCookies: string[];
}

type AuthenticatedSession = RequestAuthentication & { accessToken: string };

export class SupabaseAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "SupabaseAuthError";
  }
}

const ACCESS_COOKIE = "aval-sb-access";
const REFRESH_COOKIE = "aval-sb-refresh";
export const ACTIVE_ORGANIZATION_COOKIE = "aval-active-organization";
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

function configuration(bindings: SupabaseAuthBindings): { url: string; anonKey: string } {
  const url = bindings.SUPABASE_URL?.replace(/\/$/, "");
  const anonKey = bindings.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase Auth is not configured");
  return { url, anonKey };
}

function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try { result.set(key, decodeURIComponent(value)); } catch { /* Ignore malformed cookies. */ }
  }
  return result;
}

function cookieSecurity(request: Request): string {
  const hostname = (() => { try { return new URL(request.url).hostname; } catch { return ""; } })();
  return hostname === "localhost" || hostname === "127.0.0.1" ? "" : "; Secure";
}

function sessionCookies(request: Request, session: SupabaseSessionPayload): string[] {
  const secure = cookieSecurity(request);
  const base = `HttpOnly; SameSite=Lax; Path=/${secure}`;
  return [
    `${ACCESS_COOKIE}=${encodeURIComponent(session.access_token)}; ${base}; Max-Age=${Math.max(1, Math.floor(session.expires_in))}`,
    `${REFRESH_COOKIE}=${encodeURIComponent(session.refresh_token)}; ${base}; Max-Age=${REFRESH_MAX_AGE}`,
  ];
}

export function clearSupabaseSessionCookies(request: Request): string[] {
  const secure = cookieSecurity(request);
  const base = `HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=0`;
  return [`${ACCESS_COOKIE}=; ${base}`, `${REFRESH_COOKIE}=; ${base}`, clearActiveOrganizationCookie(request)];
}

export function activeOrganizationFromRequest(request: Request): string | undefined {
  const value = cookies(request).get(ACTIVE_ORGANIZATION_COOKIE);
  return value && value.length <= 256 ? value : undefined;
}

export function activeOrganizationCookie(request: Request, organizationId: string): string {
  if (!organizationId || organizationId.length > 256 || organizationId.includes("\0")) throw new Error("Invalid organization cookie");
  return `${ACTIVE_ORGANIZATION_COOKIE}=${encodeURIComponent(organizationId)}; HttpOnly; SameSite=Lax; Path=/${cookieSecurity(request)}; Max-Age=${REFRESH_MAX_AGE}`;
}

function clearActiveOrganizationCookie(request: Request): string {
  return `${ACTIVE_ORGANIZATION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/${cookieSecurity(request)}; Max-Age=0`;
}

async function authFetch(bindings: SupabaseAuthBindings, path: string, init: RequestInit = {}): Promise<Response> {
  const { url, anonKey } = configuration(bindings);
  return fetch(`${url}/auth/v1/${path}`, {
    ...init,
    // Cloudflare Workers supports `follow` and `manual`, but rejects the
    // browser-only `error` mode before the request reaches Supabase.
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
    headers: {
      apikey: anonKey,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function responseError(response: Response, fallback: string): Promise<SupabaseAuthError> {
  const body = await response.json().catch(() => ({})) as { msg?: string; message?: string; error_description?: string };
  const upstream = body.msg ?? body.message ?? body.error_description;
  return new SupabaseAuthError(response.status, typeof upstream === "string" && upstream.length < 300 ? upstream : fallback);
}

function verifiedIdentity(user: SupabaseUser): VerifiedSupabaseIdentity | null {
  const email = user.email?.trim().toLowerCase();
  if (!user.id || !email || !(user.email_confirmed_at ?? user.confirmed_at)) return null;
  const metadataName = user.user_metadata?.display_name ?? user.user_metadata?.full_name ?? user.user_metadata?.name;
  return {
    userId: user.id,
    email,
    displayName: typeof metadataName === "string" && metadataName.trim() ? metadataName.trim().slice(0, 160) : email,
    emailVerified: true,
  };
}

async function authenticatedSession(request: Request, bindings: SupabaseAuthBindings): Promise<AuthenticatedSession | null> {
  const requestCookies = cookies(request);
  const accessToken = requestCookies.get(ACCESS_COOKIE);
  if (accessToken) {
    const response = await authFetch(bindings, "user", { headers: { authorization: `Bearer ${accessToken}` } });
    if (response.ok) {
      const identity = verifiedIdentity(await response.json() as SupabaseUser);
      return identity ? { identity, accessToken, responseCookies: [] } : null;
    }
  }

  const refreshToken = requestCookies.get(REFRESH_COOKIE);
  if (!refreshToken) return null;
  const response = await authFetch(bindings, "token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return null;
  const session = await response.json() as SupabaseSessionPayload;
  const identity = verifiedIdentity(session.user);
  return identity ? { identity, accessToken: session.access_token, responseCookies: sessionCookies(request, session) } : null;
}

export async function authenticateSupabaseRequest(request: Request, bindings: SupabaseAuthBindings): Promise<RequestAuthentication | null> {
  const session = await authenticatedSession(request, bindings);
  return session ? { identity: session.identity, responseCookies: session.responseCookies } : null;
}

export async function signInWithSupabasePassword(
  request: Request,
  bindings: SupabaseAuthBindings,
  email: string,
  password: string,
): Promise<{ identity: VerifiedSupabaseIdentity; cookies: string[] }> {
  const response = await authFetch(bindings, "token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw await responseError(response, "Unable to sign in");
  const session = await response.json() as SupabaseSessionPayload;
  const identity = verifiedIdentity(session.user);
  if (!identity) throw new SupabaseAuthError(403, "Verify your email before signing in.");
  return { identity, cookies: sessionCookies(request, session) };
}

export async function signUpWithSupabasePassword(
  request: Request,
  bindings: SupabaseAuthBindings,
  input: { email: string; password: string; displayName: string; emailRedirectTo?: string },
): Promise<{ verificationRequired: boolean; identity?: VerifiedSupabaseIdentity; cookies: string[] }> {
  const response = await authFetch(bindings, "signup", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      data: { display_name: input.displayName },
      ...(input.emailRedirectTo ? { email_redirect_to: input.emailRedirectTo } : {}),
    }),
  });
  if (!response.ok) throw await responseError(response, "Unable to create account");
  const body = await response.json() as Partial<SupabaseSessionPayload> & { user?: SupabaseUser };
  if (!body.access_token || !body.refresh_token || !body.expires_in || !body.user) {
    return { verificationRequired: true, cookies: [] };
  }
  const identity = verifiedIdentity(body.user);
  if (!identity) return { verificationRequired: true, cookies: [] };
  const session = body as SupabaseSessionPayload;
  return { verificationRequired: false, identity, cookies: sessionCookies(request, session) };
}

export async function requestSupabasePasswordReset(
  bindings: SupabaseAuthBindings,
  email: string,
  redirectTo: string,
): Promise<void> {
  const response = await authFetch(bindings, `recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    body: JSON.stringify({ email, gotrue_meta_security: {} }),
  });
  if (!response.ok) throw await responseError(response, "Unable to send password reset email");
}

export async function resendSupabaseSignupVerification(
  bindings: SupabaseAuthBindings,
  email: string,
  redirectTo: string,
): Promise<void> {
  const response = await authFetch(bindings, `resend?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    body: JSON.stringify({ type: "signup", email, gotrue_meta_security: {} }),
  });
  if (!response.ok) throw await responseError(response, "Unable to resend verification email");
}

export async function verifySupabaseRecoveryToken(
  request: Request,
  bindings: SupabaseAuthBindings,
  tokenHash: string,
): Promise<{ identity: VerifiedSupabaseIdentity; cookies: string[] }> {
  const response = await authFetch(bindings, "verify", {
    method: "POST",
    body: JSON.stringify({ token_hash: tokenHash, type: "recovery", gotrue_meta_security: {} }),
  });
  if (!response.ok) throw await responseError(response, "The password reset link is invalid or expired");
  const session = await response.json() as SupabaseSessionPayload;
  const identity = verifiedIdentity(session.user);
  if (!identity) throw new SupabaseAuthError(403, "The password reset link is invalid or expired");
  return { identity, cookies: sessionCookies(request, session) };
}

export async function updateSupabasePassword(
  request: Request,
  bindings: SupabaseAuthBindings,
  password: string,
): Promise<string[]> {
  const session = await authenticatedSession(request, bindings);
  if (!session) throw new SupabaseAuthError(401, "The password reset session is invalid or expired");
  const response = await authFetch(bindings, "user", {
    method: "PUT",
    headers: { authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw await responseError(response, "Unable to update password");
  return session.responseCookies;
}

export async function signOutFromSupabase(request: Request, bindings: SupabaseAuthBindings): Promise<string[]> {
  const accessToken = cookies(request).get(ACCESS_COOKIE);
  if (accessToken) {
    await authFetch(bindings, "logout", { method: "POST", headers: { authorization: `Bearer ${accessToken}` } }).catch(() => null);
  }
  return clearSupabaseSessionCookies(request);
}

export function appendResponseCookies(response: Response, values: string[]): Response {
  if (values.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const value of values) headers.append("set-cookie", value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
