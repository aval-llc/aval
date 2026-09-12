/** Bounded provider HTTP. No redirects, credential echo, or unbounded retry loops. */
export class ProviderHttpError extends Error {
  constructor(public status: number, public retryable: boolean, public retryAfterSeconds = 0) {
    super(status === 401 ? "Provider authorization expired or was rejected. Reconnect this account." : status === 403 ? "The provider denied the requested permission. Check account access and app approval." : status === 429 ? "The provider is rate limiting requests. Retry after the indicated delay." : `Provider request failed (${status}).`);
  }
}
export async function providerJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Invalid provider endpoint");
  let response: Response;
  // Workers supports manual/follow. Inspect 3xx without forwarding credentials.
  try { response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15000) }); }
  catch { throw new ProviderHttpError(503, true); }
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry) - Date.now()) / 1000) : 0;
    await response.body?.cancel();
    throw new ProviderHttpError(response.status, response.status === 429 || response.status >= 500, Math.max(0, Math.min(Number.isFinite(seconds) ? seconds : 0, 3600)));
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) { await reader.cancel(); throw new Error("Provider response exceeds the safe page size"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Provider returned invalid JSON"); }
  if (payload && typeof payload === "object" && ("error" in payload && (payload as { error: unknown }).error || "ok" in payload && (payload as { ok: unknown }).ok === false)) throw new Error("Provider rejected the request. Check the app configuration and permissions.");
  return payload;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider returned an unexpected response shape");
  return value as Record<string, unknown>;
}
export function requiredString(value: unknown, label = "identifier", maxLength = 500): string {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim() || String(value).length > maxLength) throw new Error(`Provider returned no valid ${label}`);
  return String(value);
}
export function safeSegment(value: string): string {
  if (!value || value === "." || value === ".." || value.length > 500 || Array.from(value).some((char) => char.charCodeAt(0) < 32)) throw new Error("Invalid provider resource identifier");
  return encodeURIComponent(value);
}
export function basicAuth(username: string, password: string) { return `Basic ${btoa(`${username}:${password}`)}`; }
