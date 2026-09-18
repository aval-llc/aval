import { signUpWithSupabasePassword, SupabaseAuthError } from "@/lib/auth/supabase";
import { runtimeBindings } from "@/lib/runtime/bindings";
import { withSystemSession } from "@/lib/api/with-session";
import { clientIp, isRateLimited, recordAttempt } from "@/lib/security/rate-limit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_DISPLAY_NAME_CHARS = 80;
const SIGNUP_IP_RULE = { limit: 6, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string; displayName?: string };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = typeof body.displayName === "string" && body.displayName.trim()
    ? body.displayName.trim().slice(0, MAX_DISPLAY_NAME_CHARS)
    : email;
  if (!EMAIL_RE.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  if (password.length < 8) return Response.json({ error: "Use a password with at least 8 characters." }, { status: 400 });

  const ipScope = `signup:ip:${clientIp(request)}`;
  const limited = await withSystemSession("auth", async (session) => {
    const denied = await isRateLimited(session, ipScope, SIGNUP_IP_RULE);
    await recordAttempt(session, ipScope);
    return denied;
  });
  if (limited) return Response.json({ error: "Too many accounts created from this network recently. Try again later." }, { status: 429 });

  try {
    const origin = new URL(request.url).origin;
    const result = await signUpWithSupabasePassword(request, runtimeBindings(), {
      email,
      password,
      displayName,
      emailRedirectTo: `${origin}/?signin`,
    });
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    for (const cookie of result.cookies) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ email, displayName, verificationRequired: result.verificationRequired }), {
      status: result.verificationRequired ? 202 : 200,
      headers,
    });
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      const status = error.status === 429 ? 429 : error.status === 422 || error.status === 400 ? 400 : error.status;
      return Response.json({ error: status === 429 ? "Too many attempts. Try again later." : error.message }, { status });
    }
    throw error;
  }
}
