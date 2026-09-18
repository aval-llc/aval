import { signInWithSupabasePassword, SupabaseAuthError } from "@/lib/auth/supabase";
import { runtimeBindings } from "@/lib/runtime/bindings";
import { withSystemSession } from "@/lib/api/with-session";
import { clientIp, isRateLimited, recordAttempt } from "@/lib/security/rate-limit";

const LOGIN_IP_RULE = { limit: 30, windowMs: 15 * 60 * 1000 };
const LOGIN_EMAIL_RULE = { limit: 8, windowMs: 15 * 60 * 1000 };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return Response.json({ error: "Email and password are required." }, { status: 400 });

  const ipScope = `login:ip:${clientIp(request)}`;
  const emailScope = `login:email:${email}`;
  const limited = await withSystemSession("auth", async (session) => {
    const denied = (await isRateLimited(session, ipScope, LOGIN_IP_RULE)) || (await isRateLimited(session, emailScope, LOGIN_EMAIL_RULE));
    await recordAttempt(session, ipScope);
    await recordAttempt(session, emailScope);
    return denied;
  });
  if (limited) return Response.json({ error: "Too many attempts. Try again later." }, { status: 429 });

  try {
    const result = await signInWithSupabasePassword(request, runtimeBindings(), email, password);
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    for (const cookie of result.cookies) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ email: result.identity.email, displayName: result.identity.displayName }), { status: 200, headers });
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      const status = error.status === 429 ? 429 : error.status === 403 ? 403 : 401;
      const message = status === 403 ? error.message : status === 429 ? "Too many attempts. Try again later." : "Incorrect email or password.";
      return Response.json({ error: message }, { status });
    }
    throw error;
  }
}
