/**
 * Which Leads and Specialists an objective most likely needs, within what the
 * workspace's business makes reachable.
 *
 * Deterministic on purpose. The model still decides the plan, but it decides
 * among candidates this function names, and those candidates can be tested:
 * the same objective for the same profile always produces the same ranking.
 * Anything outside the profile's eligible domains is not a candidate at all —
 * and delegation refuses it independently (delegation.ts), so a model that
 * names one anyway gets nowhere.
 *
 * Scoring is overlap with what each Specialist declares suggests it — its
 * triggers and its name. A whole trigger phrase counts most; a shared word
 * counts by how rare it is across the catalogue, compared on a short stem.
 * Ties break on catalogue order, so the ranking is stable.
 */

import { LEADS, SPECIALISTS, eligibleDomains, leadRuntimeId } from "./index.ts";
import type { OperatingProfile } from "../../organizations/operating-profile.ts";
import type { DomainId } from "./types.ts";

export interface RoutedSpecialist { id: string; name: string; domain: DomainId; score: number; matched: string[] }
export interface RoutedLead { id: string; name: string; domain: DomainId; score: number }
export interface RoutingResult {
  eligibleDomains: DomainId[];
  leads: RoutedLead[];
  specialists: RoutedSpecialist[];
  /** True when one domain clearly carries the objective, so Aval One may address its Specialist directly. */
  singleDomain: boolean;
}

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function matches(haystack: string, trigger: string): boolean {
  const needle = normalize(trigger);
  return needle.trim().length > 0 && haystack.includes(needle);
}

/** Words too common in property work to say anything about which job it is. */
const STOPWORDS = new Set([
  ..."the a an and or of for to in on at by with from this that these those our their your its is are was be been has have had will can may should would what which who how when where why not no do does please need needs about into over under per each all any there here".split(" "),
  // The act of asking, not the job asked about: "prepare", "report", "send"
  // appear in requests to every specialist alike.
  ..."report reports reported reporting prepare prepared review reviewed submit submitted send sent make made get got check checked want help update updated handle handled create created give show tell find look".split(" "),
]);

function words(text: string): string[] {
  return normalize(text).trim().split(" ").filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/** "recertification" and "recertify", "reconcile" and "reconciliation": a shared six-letter stem is the same word. */
function sameWord(a: string, b: string): boolean {
  return a === b || (a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6));
}

/** Each specialist's vocabulary: the words of its triggers and its name. */
const VOCABULARY = new Map(SPECIALISTS.map((specialist) => [specialist.id, [...new Set([...specialist.triggers.flatMap(words), ...words(specialist.name)])]]));

/**
 * How much a shared word says. A word nearly every specialist uses ("owner",
 * "request", "report") says almost nothing about which job this is; a word only
 * one uses ("cam", "recertification") says a great deal. Classic inverse
 * document frequency over the catalogue.
 */
const WEIGHT = (() => {
  const documents = new Map<string, number>();
  for (const vocabulary of VOCABULARY.values()) for (const word of vocabulary) documents.set(word, (documents.get(word) ?? 0) + 1);
  return (word: string) => Math.log((SPECIALISTS.length + 1) / ((documents.get(word) ?? 0) + 1));
})();

/** A whole trigger phrase is strong evidence; each shared word counts by its rarity. */
function score(objective: string, objectiveWords: readonly string[], specialistId: string, triggers: readonly string[]): { score: number; matched: string[] } {
  const whole = triggers.filter((trigger) => trigger.includes(" ") && matches(objective, trigger));
  const shared = (VOCABULARY.get(specialistId) ?? []).filter((word) => objectiveWords.some((candidate) => sameWord(candidate, word)));
  const value = whole.length * 6 + shared.reduce((total, word) => total + WEIGHT(word), 0);
  return { score: Math.round(value * 100) / 100, matched: [...whole, ...shared] };
}

/** Below this a match is coincidence — one common word — not a reason to route. */
const MIN_SCORE = 2.5;

export function routeObjective(objective: string, profile: OperatingProfile, limit = 5): RoutingResult {
  const eligible = eligibleDomains(profile);
  const text = normalize(objective);
  const objectiveWords = words(objective);
  const scored: RoutedSpecialist[] = [];
  for (const specialist of SPECIALISTS) {
    if (!eligible.has(specialist.domain)) continue;
    const result = score(text, objectiveWords, specialist.id, specialist.triggers);
    if (result.score >= MIN_SCORE) scored.push({ id: specialist.id, name: specialist.name, domain: specialist.domain, ...result });
  }
  const order = new Map(SPECIALISTS.map((specialist, index) => [specialist.id, index]));
  scored.sort((a, b) => b.score - a.score || order.get(a.id)! - order.get(b.id)!);

  // A Lead is as relevant as its best-matching specialist. Summing would let a
  // large domain win on many weak matches over the one strong one.
  const byDomain = new Map<DomainId, number>();
  for (const specialist of scored) byDomain.set(specialist.domain, Math.max(byDomain.get(specialist.domain) ?? 0, specialist.score));
  const leads = LEADS
    .filter((lead) => byDomain.has(lead.domain))
    .map((lead) => ({ id: leadRuntimeId(lead), name: lead.name, domain: lead.domain, score: byDomain.get(lead.domain)! }))
    .sort((a, b) => b.score - a.score);

  return {
    eligibleDomains: [...eligible],
    leads: leads.slice(0, limit),
    specialists: scored.slice(0, limit),
    singleDomain: leads.length === 1 || (leads.length > 1 && leads[0].score >= 1.5 * leads[1].score),
  };
}
