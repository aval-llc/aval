/**
 * Whether an Ask Aval turn needs the organization, or can be answered directly.
 *
 * Most questions are reads: "what is our occupancy", "how many work orders are
 * open". The single-turn loop answers those from the tools, and fanning them
 * out to Leads and Specialists would only be slower and dearer. A turn needs
 * the organization when it asks for work — something done, prepared or
 * coordinated in a specialist's domain — or when it spans domains and asks for
 * more than a lookup. Those become durable Work (lib/agents/open-work.ts) and
 * run Aval One → Lead → Specialist, the same path as every other Work.
 *
 * Deterministic, so the same question in the same workspace always takes the
 * same path, and the reason is recorded with it. The person never has to pick
 * a Lead or Specialist: the router (routing.ts) names the candidates, and Aval
 * One plans among them.
 */

import { routeObjective, type RoutingResult } from "./routing.ts";
import type { OperatingProfile } from "../../organizations/operating-profile.ts";

/** Verbs that ask for something to be done rather than told. */
const ACTION_WORDS = new Set([
  "create", "open", "raise", "log", "schedule", "reschedule", "book", "dispatch", "send", "email", "text", "notify", "call",
  "draft", "prepare", "reconcile", "post", "record", "publish", "renew", "follow", "chase", "arrange", "coordinate", "assign",
  "fix", "repair", "handle", "resolve", "file", "submit", "collect", "remind", "investigate", "audit", "set", "start", "cancel",
  "request", "onboard", "process", "screen", "verify", "inspect", "market", "bill", "invoice", "track",
]);

/** Asking someone to do something, however politely. */
const REQUEST = /\b(can|could|would|will) you\b|\bplease\b|\b(i|we) (need|want|would like) (you )?to\b|\blet'?s\b/;

const INTERROGATIVE = /^(what|whats|how|which|who|whom|when|where|why|is|are|was|were|do|does|did|can|could|should|will|would|show|tell)\b/;

/** Below this the top candidate matched by coincidence rather than by the objective. */
const MIN_CANDIDATE_SCORE = 4;

export interface OrchestrationDecision {
  delegate: boolean;
  reason: "no_specialist_work" | "question_answered_directly" | "action_requested" | "spans_domains";
  routing: RoutingResult;
}

export function orchestrationDecision(question: string, profile: OperatingProfile): OrchestrationDecision {
  const routing = routeObjective(question, profile);
  const top = routing.specialists[0];
  if (!top || top.score < MIN_CANDIDATE_SCORE) return { delegate: false, reason: "no_specialist_work", routing };

  // An action word asks for work only where it is being used as a verb: at
  // the head of a clause ("…, open a work order and dispatch a plumber"), or
  // inside an explicit request ("can you reconcile…"). "How many open work
  // orders are there" uses "open" as an adjective and stays a question.
  const lowered = question.toLowerCase();
  const text = lowered.replace(/[^a-z0-9?' ]+/g, " ").trim();
  const clauses = lowered.split(/[,.;:!?\n]|\band\b|\bthen\b|\balso\b/).map((clause) => clause.trim().replace(/^(please|now|next|also)\s+/, ""));
  const heads = clauses.map((clause) => clause.split(/[^a-z']+/)[0]).filter(Boolean);
  const words = text.replace(/[?']/g, " ").split(/\s+/);
  const asksForAction = heads.some((word) => ACTION_WORDS.has(word)) || (REQUEST.test(text) && words.some((word) => ACTION_WORDS.has(word)));
  const interrogative = INTERROGATIVE.test(text) && !asksForAction;
  const [first, second] = routing.leads;
  const spansDomains = Boolean(first && second && second.score >= MIN_CANDIDATE_SCORE && second.score >= 0.6 * first.score);

  if (asksForAction) return { delegate: true, reason: "action_requested", routing };
  if (spansDomains && !interrogative) return { delegate: true, reason: "spans_domains", routing };
  return { delegate: false, reason: "question_answered_directly", routing };
}
