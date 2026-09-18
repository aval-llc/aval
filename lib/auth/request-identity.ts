import type { VerifiedSupabaseIdentity } from "./supabase";

const SUBJECT = "x-aval-internal-subject";
const EMAIL = "x-aval-internal-email";
const NAME = "x-aval-internal-name";

const untrustedIdentityHeaders = [
  SUBJECT,
  EMAIL,
  NAME,
  "oai-authenticated-user-id",
  "oai-authenticated-user-email",
  "oai-authenticated-user-full-name",
];

/** Strip every identity header before the public request enters the app. */
export function withoutUntrustedIdentityHeaders(headers: Headers): Headers {
  const clean = new Headers(headers);
  for (const name of untrustedIdentityHeaders) clean.delete(name);
  return clean;
}

/** Called only by worker/index.ts after Supabase has validated the token. */
export function withVerifiedIdentityHeaders(headers: Headers, identity: VerifiedSupabaseIdentity): Headers {
  const trusted = withoutUntrustedIdentityHeaders(headers);
  trusted.set(SUBJECT, identity.userId);
  trusted.set(EMAIL, encodeURIComponent(identity.email));
  trusted.set(NAME, encodeURIComponent(identity.displayName));
  return trusted;
}

/** Internal headers are trusted because worker/index.ts always strips them. */
export function verifiedIdentityFromRequest(request: Request): VerifiedSupabaseIdentity | null {
  const userId = request.headers.get(SUBJECT);
  const encodedEmail = request.headers.get(EMAIL);
  const encodedName = request.headers.get(NAME);
  if (!userId || !encodedEmail || !encodedName) return null;
  try {
    const email = decodeURIComponent(encodedEmail).trim().toLowerCase();
    const displayName = decodeURIComponent(encodedName).trim();
    if (!email || !displayName || userId.length > 256 || email.length > 320 || displayName.length > 160) return null;
    return { userId, email, displayName, emailVerified: true };
  } catch {
    return null;
  }
}
