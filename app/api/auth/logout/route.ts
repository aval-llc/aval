import { signOutFromSupabase } from "@/lib/auth/supabase";
import { runtimeBindings } from "@/lib/runtime/bindings";

export async function POST(request: Request) {
  const cookies = await signOutFromSupabase(request, runtimeBindings());
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
