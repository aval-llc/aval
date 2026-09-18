import type { DbSession } from "@/db/postgres/session";
/**
 * POST /api/infrastructure/bills/extract
 *
 * Turns a utility bill's raw text into structured fields a user can review
 * and confirm before it's saved as a `utility_bills` row. Never persists by
 * itself — extraction is a draft, the same "AI proposes, a human writes it"
 * shape as Ask Aval's draft/decision flows elsewhere in this app.
 *
 * A GitHub sourcing pass for utility-bill parsing (docs/DECISIONS.md) found
 * nothing beyond a 0-star proof-of-concept — production tools in this space
 * are commercial data brokers (Urjanet/Arcadia-style), not OSS. Aval already
 * has the shared model router wired in for document work
 * — reusing it for structured extraction is more realistic than adopting a
 * fragile scraper/OCR pipeline, and it costs against the same per-org daily
 * cap and token balance as every other model call in this app.
 */

import { ModelProviderError, type AskAvalEnv, type Message, type ToolSchema, type ToolUseBlock } from "@/lib/ask-aval/model-types";
import { callModel } from "@/lib/ask-aval/model-router";
import { checkUsageBlocked, recordUsage, type AskAvalSession } from "@/lib/ask-aval/usage";
import { json } from "@/lib/ask-aval/loop";
import type { UtilityType } from "./types";

const MAX_BILL_TEXT_CHARS = 6000;
const TOOL_NAME = "extract_utility_bill";

export interface ExtractedUtilityBill {
  utilityType: UtilityType;
  provider: string | null;
  periodStart: string;
  periodEnd: string;
  usageAmount: number;
  unitOfMeasure: string;
  costCents: number;
  currency: "USD" | "MXN";
  confidence: "high" | "low";
  note: string | null;
}

const EXTRACT_TOOL: ToolSchema = {
  name: TOOL_NAME,
  description: "Report the structured fields read from a utility bill's raw text.",
  input_schema: {
    type: "object",
    properties: {
      utility_type: { type: "string", enum: ["electricity", "water", "gas"] },
      provider: { type: "string", description: "The utility company's name, or omit if not present in the text." },
      period_start: { type: "string", description: "ISO 8601 date (YYYY-MM-DD), the billing period's start." },
      period_end: { type: "string", description: "ISO 8601 date (YYYY-MM-DD), the billing period's end." },
      usage_amount: { type: "number", description: "The metered usage quantity for this period." },
      unit_of_measure: { type: "string", description: "e.g. kWh, gal, ccf, therm, m3 — whatever unit the bill itself uses." },
      cost_cents: { type: "integer", description: "Total amount due, in the bill's own currency, converted to minor units (dollars/pesos * 100, rounded)." },
      currency: { type: "string", enum: ["USD", "MXN"] },
      confidence: {
        type: "string",
        enum: ["high", "low"],
        description: "\"low\" if any field had to be guessed, was ambiguous, or was missing from the text — never guess silently.",
      },
      note: { type: "string", description: "Any caveat about a field you weren't sure of. Empty string if none." },
    },
    required: ["utility_type", "period_start", "period_end", "usage_amount", "unit_of_measure", "cost_cents", "currency", "confidence", "note"],
  },
};

const SYSTEM = `You extract structured data from a single utility bill's raw text, for a property-management system that will let a human review and confirm your reading before it's saved.

Hard rules:
- Only report values that actually appear in the text (arithmetic to normalize units or currency to cents is fine; inventing a missing figure is not).
- If a required field is missing or ambiguous in the text, make your best reading but set confidence to "low" and say what was uncertain in "note". Never guess silently.
- cost_cents must be the total amount due, in minor units of the bill's own currency.
Call extract_utility_bill exactly once. Write no prose outside it.`;

export async function handleUtilityBillExtraction(dbSession: DbSession, rawBillText: string, env: AskAvalEnv, session: AskAvalSession): Promise<Response> {
  const billText = rawBillText.trim().slice(0, MAX_BILL_TEXT_CHARS);
  if (!billText) return json({ error: "Bill text is required" }, 400);

  const blockReason = await checkUsageBlocked(dbSession, env, session);
  if (blockReason === "token_balance") return json({ error: "Aval has run out of tokens for this billing period. Purchase more to continue.", code: "token_balance" }, 402);
  if (blockReason === "daily_cap") return json({ error: "Aval has reached its usage cap for today. Try again tomorrow.", code: "daily_cap" }, 429);

  const messages: Message[] = [{ role: "user", content: billText }];

  try {
    const res = await callModel(dbSession, env, session.orgId, {
      system: SYSTEM,
      messages,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: TOOL_NAME },
      max_tokens: 1024,
    });
    await recordUsage(dbSession, session, res.usage.input_tokens, res.usage.output_tokens);

    const toolUse = res.content.find((block): block is ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME);
    if (!toolUse) return json({ error: "The model did not return a structured extraction." }, 502);

    const input = toolUse.input as Record<string, unknown>;
    const extracted: ExtractedUtilityBill = {
      utilityType: input.utility_type as UtilityType,
      provider: typeof input.provider === "string" && input.provider ? input.provider : null,
      periodStart: String(input.period_start),
      periodEnd: String(input.period_end),
      usageAmount: Number(input.usage_amount),
      unitOfMeasure: String(input.unit_of_measure),
      costCents: Math.round(Number(input.cost_cents)),
      currency: input.currency === "MXN" ? "MXN" : "USD",
      confidence: input.confidence === "low" ? "low" : "high",
      note: typeof input.note === "string" && input.note ? input.note : null,
    };

    return json({ extracted });
  } catch (err) {
    if (err instanceof ModelProviderError) return json({ error: err.message, retryable: err.retryable }, err.status >= 500 ? 502 : 400);
    console.error("utility_bill_extraction_unhandled", err);
    return json({ error: "Bill extraction is unavailable right now." }, 500);
  }
}
