/** Deliberate product gates; enabling either requires a separately reviewed rollout. */
export const PILOT_POLICY = Object.freeze({ subscriptionOAuth: false, paidCheckout: false });
export const API_KEY_REQUIRED = "The Aval pilot requires a workspace API key. Subscription sign-in is unavailable; replace this connection in Settings → Intelligence.";
export function subscriptionDisabledResponse() {
  return Response.json({ code: "api_key_required", error: API_KEY_REQUIRED }, { status: 409 });
}
