import { runtimeBindings } from "@/lib/runtime/bindings";
import { verifySupabaseRecoveryToken } from "@/lib/auth/supabase";

function internalDestination(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/[\0\r\n]/.test(value) && value.length <= 512
    ? value
    : "/en?recovery=1";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash") ?? "";
  const type = url.searchParams.get("type");
  if (type !== "recovery" || !tokenHash || tokenHash.length > 512) {
    return Response.redirect(new URL("/en?signin=1&recoveryError=1", url.origin), 303);
  }
  try {
    const result = await verifySupabaseRecoveryToken(request, runtimeBindings(), tokenHash);
    const headers = new Headers({ location: new URL(internalDestination(url.searchParams.get("next")), url.origin).href, "cache-control": "no-store" });
    for (const cookie of result.cookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  } catch {
    return Response.redirect(new URL("/en?signin=1&recoveryError=1", url.origin), 303);
  }
}
