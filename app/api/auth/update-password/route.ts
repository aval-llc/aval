import { verifiedIdentityFromRequest } from "@/lib/auth/request-identity";
import { runtimeBindings } from "@/lib/runtime/bindings";
import { SupabaseAuthError, updateSupabasePassword } from "@/lib/auth/supabase";

export async function POST(request: Request) {
  if (!verifiedIdentityFromRequest(request)) return Response.json({ error: "The password reset session is invalid or expired." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { password?: string };
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) return Response.json({ error: "Use a password with at least 8 characters." }, { status: 400 });
  try {
    const cookies = await updateSupabasePassword(request, runtimeBindings(), password);
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ updated: true }), { headers });
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      return Response.json({ error: error.status === 401 ? "The password reset session is invalid or expired." : "Unable to update password. Try another password." }, { status: error.status === 401 ? 401 : 400 });
    }
    throw error;
  }
}
