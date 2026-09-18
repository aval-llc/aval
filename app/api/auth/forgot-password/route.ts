import { requestSupabasePasswordReset, SupabaseAuthError } from "@/lib/auth/supabase";
import { runtimeBindings } from "@/lib/runtime/bindings";
import { withSystemSession } from "@/lib/api/with-session";
import { clientIp, isRateLimited, recordAttempt } from "@/lib/security/rate-limit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RULE = { limit: 5, windowMs: 60 * 60 * 1000 };
const GENERIC = "If an account exists for that email, Aval sent password reset instructions.";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { email?: string };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  const scope = `password-reset:${clientIp(request)}:${email}`;
  const limited = await withSystemSession("auth", async session => {
    const denied = await isRateLimited(session, scope, RULE);
    await recordAttempt(session, scope);
    return denied;
  });
  if (limited) return Response.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  try {
    const origin = new URL(request.url).origin;
    await requestSupabasePasswordReset(runtimeBindings(), email, `${origin}/api/auth/confirm?next=%2Fen%3Frecovery%3D1`);
  } catch (error) {
    // Supabase intentionally does not distinguish unknown accounts. Keep the
    // same response for every Auth outcome so Aval does not reintroduce that leak.
    if (!(error instanceof SupabaseAuthError)) throw error;
  }
  return Response.json({ message: GENERIC }, { headers: { "cache-control": "no-store" } });
}
