/** Context bytes are a storage bound. Token estimates are admission hints, not provider usage. */
export const estimateInputTokens = (value: unknown) => Math.ceil(new TextEncoder().encode(JSON.stringify(value)).length / 3);
// Admission v2: observed subscription reviews exceeded the original 24k reserve.
// This changes admission, never task/evaluation caps or the provider's output limit.
export const MAINTENANCE_REVIEW_RESERVE = 64_000;
export const MAINTENANCE_ADMISSION_VERSION = 'maintenance-admission-v2';
export function maintenanceAdmission(remaining: number, review: boolean, observedActor = 0, observedReview = 0) {
  const reviewTokens = Math.max(MAINTENANCE_REVIEW_RESERVE, observedReview);
  const callTokens = review ? reviewTokens : Math.max(64_000, observedActor);
  const verificationReserve = review ? 0 : reviewTokens;
  return { version: MAINTENANCE_ADMISSION_VERSION, callTokens, verificationReserve, remaining, allowed: remaining >= callTokens + verificationReserve };
}
export function modelBudget(input: { remaining: number; system: string; tools: unknown; messages: unknown; reviewReserve?: number }) {
  const estimatedInput = estimateInputTokens({ system: input.system, tools: input.tools, messages: input.messages });
  return { estimatedInput, outputTokens: Math.min(2048, input.remaining - estimatedInput - (input.reviewReserve ?? 0)) };
}
