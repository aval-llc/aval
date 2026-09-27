/** Context bytes are a storage bound. Token estimates are admission hints, not provider usage. */
export const estimateInputTokens = (value: unknown) => Math.ceil(new TextEncoder().encode(JSON.stringify(value)).length / 3);
export const MAINTENANCE_REVIEW_RESERVE = 24_000;
export function modelBudget(input: { remaining: number; system: string; tools: unknown; messages: unknown; reviewReserve?: number }) {
  const estimatedInput = estimateInputTokens({ system: input.system, tools: input.tools, messages: input.messages });
  return { estimatedInput, outputTokens: Math.min(2048, input.remaining - estimatedInput - (input.reviewReserve ?? 0)) };
}
