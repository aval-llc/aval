/**
 * Choosing which expertise the work in front of an employee actually needs.
 *
 * Deterministic first, and a model only where determinism genuinely cannot
 * decide. That order is not a performance preference: a routing rule that can
 * be read is a routing rule that can be tested, disputed and corrected, and
 * "why did Maya treat this as an escalation" should have an answer that does
 * not involve rerunning a model.
 *
 * Nothing here reads a database or calls anything. It scores the routing
 * metadata it is handed and returns a decision, which is what makes the rules
 * testable without a catalogue, an employee or a provider.
 */

export type RiskTier = "low" | "medium" | "high" | "critical";

const RISK_ORDER: Record<RiskTier, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface ExpertiseCandidateInput {
  slug: string;
  /** Broad competences this expertise claims: `maintenance`, `escalation`. */
  capabilityTags: readonly string[];
  /** Business areas it belongs to: `resident`, `vendor`, `financial`. */
  domains: readonly string[];
  /** Words and work types that suggest it: `leak`, `hvac`, `no_hot_water`. */
  routingSignals: readonly string[];
  /** Tools it cannot work without. Missing one excludes it outright. */
  requiredCapabilities: readonly string[];
  riskCeiling: RiskTier;
  /** Always loaded, whatever the work looks like. */
  pinned?: boolean;
}

export interface WorkSignals {
  /** What kind of work this is, if the intake knew: `maintenance_request`. */
  workType?: string | null;
  /** The objective in the customer's words. Matched case-insensitively, whole word. */
  objective?: string | null;
  /** Entities the work concerns: `resident`, `unit`, `vendor`. */
  entityTypes?: readonly string[];
  /** Domains the work already belongs to. */
  domains?: readonly string[];
  /** Tools actually available for this work after narrowing. */
  availableCapabilities?: readonly string[];
  /** How risky the work is. Expertise that refuses this tier is excluded. */
  riskTier?: RiskTier;
}

export interface ScoredCandidate {
  slug: string;
  score: number;
  /** Why it scored what it did, in the terms an operator would ask about. */
  matched: string[];
  /** Set when the candidate was ruled out rather than merely outscored. */
  excluded?: "missing_capability" | "risk_ceiling";
}

export interface RoutingDecision {
  /** Every candidate considered, best first, including the excluded ones. */
  candidates: ScoredCandidate[];
  /** What to load. */
  selected: string[];
  signals: WorkSignals;
  decidedBy: "deterministic" | "model" | "user";
  /** True when the top of the field is tied and a model could break it. */
  ambiguous: boolean;
}

/** How many expertise profiles may be loaded for one piece of work. */
export const MAX_SELECTED_EXPERTISE = 4;

/** A candidate has to beat this to be loaded at all. */
export const SELECTION_THRESHOLD = 2;

const WEIGHTS = { routingSignal: 3, workType: 3, domain: 2, capabilityTag: 2, entity: 1 } as const;

const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * Whole-word containment.
 *
 * Substring matching would let `hvac` fire on `hvacuum` and, worse, let a short
 * signal like `ac` match almost anything. Expertise selection decides what an
 * employee is briefed on, so a false positive is a real cost.
 */
function mentions(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/** Scores one candidate against the work. */
export function scoreCandidate(candidate: ExpertiseCandidateInput, signals: WorkSignals): ScoredCandidate {
  const matched: string[] = [];

  // Exclusions first: a candidate that cannot run is not a candidate, however
  // well it reads.
  const available = new Set((signals.availableCapabilities ?? []).map(normalize));
  const missing = candidate.requiredCapabilities.filter((required) => !available.has(normalize(required)));
  if (missing.length > 0) {
    return { slug: candidate.slug, score: 0, matched: [], excluded: "missing_capability" };
  }
  if (signals.riskTier && RISK_ORDER[signals.riskTier] > RISK_ORDER[candidate.riskCeiling]) {
    return { slug: candidate.slug, score: 0, matched: [], excluded: "risk_ceiling" };
  }

  let score = 0;
  const objective = signals.objective ?? "";
  const workType = signals.workType ? normalize(signals.workType) : null;

  for (const signal of candidate.routingSignals) {
    const term = normalize(signal);
    if (workType && term === workType) { score += WEIGHTS.workType; matched.push(`work type ${term}`); continue; }
    if (objective && mentions(objective, term)) { score += WEIGHTS.routingSignal; matched.push(`mentions ${term}`); }
  }

  const workDomains = new Set((signals.domains ?? []).map(normalize));
  for (const domain of candidate.domains) {
    if (workDomains.has(normalize(domain))) { score += WEIGHTS.domain; matched.push(`domain ${normalize(domain)}`); }
  }

  const entities = new Set((signals.entityTypes ?? []).map(normalize));
  for (const tag of candidate.capabilityTags) {
    const term = normalize(tag);
    if (workDomains.has(term)) { score += WEIGHTS.capabilityTag; matched.push(`tag ${term}`); }
    else if (entities.has(term)) { score += WEIGHTS.entity; matched.push(`entity ${term}`); }
  }

  return { slug: candidate.slug, score, matched };
}

/**
 * Which expertise to load for this work.
 *
 * Pinned expertise is always loaded — that is what pinning means. Everything
 * else has to earn its place, and expertise that earns nothing is not injected:
 * briefing an employee on vendor coordination for a question about a rent
 * statement makes it worse at both.
 *
 * `ambiguous` is set when the candidates at the selection boundary are tied,
 * which is the only situation where asking a model to choose adds anything.
 */
export function routeExpertise(
  candidates: readonly ExpertiseCandidateInput[],
  signals: WorkSignals,
  options: { max?: number; threshold?: number } = {},
): RoutingDecision {
  const max = options.max ?? MAX_SELECTED_EXPERTISE;
  const threshold = options.threshold ?? SELECTION_THRESHOLD;

  const scored = candidates.map((candidate) => scoreCandidate(candidate, signals));
  const pinned = new Set(candidates.filter((candidate) => candidate.pinned).map((candidate) => candidate.slug));

  // Stable ordering: score, then slug. Two runs over the same catalogue must
  // brief the employee identically, or nothing downstream is reproducible.
  const ranked = [...scored]
    .filter((candidate) => !candidate.excluded)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));

  const selected: string[] = [];
  for (const candidate of ranked) {
    if (pinned.has(candidate.slug)) selected.push(candidate.slug);
  }
  for (const candidate of ranked) {
    if (selected.length >= max) break;
    if (selected.includes(candidate.slug)) continue;
    if (candidate.score < threshold) continue;
    selected.push(candidate.slug);
  }

  // A tie *at the boundary* is the ambiguous case: the field is not deciding
  // between the chosen and the unchosen on merit.
  const boundary = ranked.filter((candidate) => !pinned.has(candidate.slug) && candidate.score >= threshold);
  const lastIn = boundary[max - 1];
  const firstOut = boundary[max];
  const ambiguous = Boolean(lastIn && firstOut && lastIn.score === firstOut.score);

  return {
    candidates: [...ranked, ...scored.filter((candidate) => candidate.excluded)],
    selected,
    signals,
    decidedBy: "deterministic",
    ambiguous,
  };
}

/**
 * Applies a person's explicit choice.
 *
 * An explicit selection is authoritative — the operator knows something the
 * signals do not — except where the expertise is excluded for a reason that is
 * not about relevance. Being unable to run, or refusing the risk tier, are not
 * preferences to override.
 */
export function applyUserSelection(
  decision: RoutingDecision,
  requested: readonly string[],
  userId: string,
): RoutingDecision & { overriddenBy: string; blocked: string[] } {
  const byslug = new Map(decision.candidates.map((candidate) => [candidate.slug, candidate]));
  const blocked: string[] = [];
  const selected: string[] = [];

  for (const slug of requested) {
    const candidate = byslug.get(slug);
    if (!candidate) { blocked.push(slug); continue; }
    if (candidate.excluded) { blocked.push(slug); continue; }
    selected.push(slug);
  }
  return { ...decision, selected, decidedBy: "user", overriddenBy: userId, blocked };
}
