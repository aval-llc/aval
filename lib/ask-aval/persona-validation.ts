/**
 * Pure validation for a workspace-defined custom persona — split out of
 * the custom-persona adapter in app/api/agents/route.ts (which also imports `@/db`, unresolvable outside the
 * Workers/Vite build) so this logic can be unit-tested directly with
 * `node --test`, matching this repo's convention of testing pure logic
 * straight and leaving D1-backed code to integration/manual verification.
 */

import type { ShapeId } from "@/app/components/agent-avatar/shapes";
import type { ThemeId } from "@/app/components/agent-avatar/themes";

export const MAX_LABEL_CHARS = 60;
export const MAX_FOCUS_CHARS = 600;

// Duplicated from tools.ts's DATA_TOOLS names rather than imported, so
// validating a custom persona's requested tools doesn't require importing
// the whole tool-schema module (which drags in app/data/sample.ts) just to
// check a handful of strings.
export const VALID_TOOL_NAMES = new Set([
  "get_portfolio_metrics",
  "get_property_breakdown",
  "get_delinquent_accounts",
  "get_leasing_funnel",
  "get_metric_series",
  "get_accounting_breakdown",
]);
export const VALID_SHAPES = new Set<ShapeId>(["arch", "shard", "portal", "fourPoint", "monolith", "planes"]);
export const VALID_THEMES = new Set<ThemeId>(["avalBlue", "violet", "aqua", "ember", "aurora", "orchid"]);

export class InvalidPersonaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPersonaInputError";
  }
}

export interface CustomPersonaInput {
  label: string;
  focusDescription: string;
  toolNames: string[] | null;
  shape: string;
  theme: string;
}

export interface ValidatedCustomPersonaInput {
  label: string;
  focusDescription: string;
  toolNames: string[] | null;
  shape: ShapeId;
  theme: ThemeId;
}

export function validateCustomPersonaInput(input: CustomPersonaInput): ValidatedCustomPersonaInput {
  const label = input.label.trim().slice(0, MAX_LABEL_CHARS);
  if (!label) throw new InvalidPersonaInputError("label is required");

  const focusDescription = input.focusDescription.trim().slice(0, MAX_FOCUS_CHARS);
  if (!focusDescription) throw new InvalidPersonaInputError("focusDescription is required");

  if (!VALID_SHAPES.has(input.shape as ShapeId)) {
    throw new InvalidPersonaInputError(`shape must be one of: ${[...VALID_SHAPES].join(", ")}`);
  }
  if (!VALID_THEMES.has(input.theme as ThemeId)) {
    throw new InvalidPersonaInputError(`theme must be one of: ${[...VALID_THEMES].join(", ")}`);
  }

  let toolNames: string[] | null = null;
  if (input.toolNames) {
    toolNames = input.toolNames.filter((name) => VALID_TOOL_NAMES.has(name));
    if (toolNames.length === 0) throw new InvalidPersonaInputError("toolNames, if provided, must include at least one recognized tool name");
  }

  return { label, focusDescription, toolNames, shape: input.shape as ShapeId, theme: input.theme as ThemeId };
}
