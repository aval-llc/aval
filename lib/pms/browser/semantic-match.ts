/**
 * Finding a thing on a page by what it is called.
 *
 * A recorded workflow names a button by its visible label and a field by the
 * text beside it. Turning that into an element is the one piece of the browser
 * path that has to be genuinely clever, and it is also the piece where being
 * clever is dangerous: the failure mode of a fuzzy matcher is clicking the
 * wrong button on somebody's property management system.
 *
 * So the rules here are ordered by confidence and stop at the first tier that
 * produces exactly one candidate:
 *
 *   1. exact match on the accessible name, case-insensitively
 *   2. exact match ignoring punctuation and collapsed whitespace
 *   3. the name begins with the wanted text, at a word boundary
 *
 * There is deliberately no fourth tier. Substring-anywhere matching is what
 * turns "Delete" into a match for "Do not delete", and no amount of scoring
 * makes that safe on a write.
 *
 * **Two candidates is not a tie to be broken.** It is an ambiguous target, and
 * the caller must stop. A provider that renamed one button and left another
 * looking similar is exactly the situation where guessing produces a confident
 * wrong action, which is worse than a workflow that refuses and asks.
 */

export interface PageNode {
  /** The accessible name: label text, aria-label, button text. */
  name: string;
  /** Roughly the ARIA role — `button`, `textbox`, `combobox`, `link`, `text`. */
  role: string;
  /** Index in document order, so a caller can address the match it found. */
  index: number;
  /** Whether the element can be interacted with at all. */
  disabled?: boolean;
}

export type MatchOutcome =
  | { found: true; node: PageNode; tier: 1 | 2 | 3 }
  /** Nothing named that. The page has changed, or the flow was never right. */
  | { found: false; reason: "absent" }
  /** Several things named that. Never resolved by picking one. */
  | { found: false; reason: "ambiguous"; candidates: PageNode[] };

/** Case, punctuation and whitespace are presentation, not identity. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Roles that can be the target of each kind of step. */
export const ROLES_FOR: Record<string, readonly string[]> = {
  click: ["button", "link", "menuitem", "tab"],
  fill: ["textbox", "searchbox", "spinbutton"],
  choose: ["combobox", "listbox", "radio", "checkbox"],
  capture: ["text", "textbox", "cell", "heading"],
};

/**
 * Find the one node called `wanted`, or say why there isn't one.
 *
 * `roles` narrows before matching rather than after, because a page that has a
 * "Unit" column heading and a "Unit" input is not ambiguous when the step is a
 * `fill` — it is ambiguous only if both could receive the action.
 */
export function matchNode(
  nodes: readonly PageNode[],
  wanted: string,
  roles: readonly string[],
): MatchOutcome {
  const eligible = nodes.filter((node) => roles.includes(node.role) && !node.disabled);
  const target = normalize(wanted);
  if (target === "") return { found: false, reason: "absent" };

  const tiers: Array<(node: PageNode) => boolean> = [
    (node) => node.name.trim().toLowerCase() === wanted.trim().toLowerCase(),
    (node) => normalize(node.name) === target,
    // Word boundary, not substring: "Delete" must not match "Do not delete".
    (node) => {
      const name = normalize(node.name);
      return name === target || name.startsWith(`${target} `);
    },
  ];

  for (const [index, matches] of tiers.entries()) {
    const found = eligible.filter(matches);
    if (found.length === 1) return { found: true, node: found[0], tier: (index + 1) as 1 | 2 | 3 };
    // Ambiguity at a tier is reported at that tier rather than falling through
    // to a looser one. A looser rule cannot separate two things a stricter rule
    // could not, and trying makes the answer arbitrary.
    if (found.length > 1) return { found: false, reason: "ambiguous", candidates: found };
  }

  return { found: false, reason: "absent" };
}

/** Whether the page says this, for an `expect` step. Presentation-insensitive. */
export function pageStates(nodes: readonly PageNode[], text: string): boolean {
  const target = normalize(text);
  return target !== "" && nodes.some((node) => normalize(node.name).includes(target));
}

/**
 * What a failed match means for the run.
 *
 * Both stop the workflow, and they are different problems. An absent target is
 * a page that changed under a recorded flow — Aval's to fix, and the flow
 * should be marked degraded. An ambiguous one is a page Aval cannot read
 * confidently enough to act on, which is a judgement call for a person.
 */
export function describeMiss(wanted: string, outcome: Extract<MatchOutcome, { found: false }>): string {
  return outcome.reason === "absent"
    ? `Nothing on this page is called "${wanted}".`
    : `More than one thing on this page is called "${wanted}" `
      + `(${outcome.candidates.map((node) => `${node.role} #${node.index}`).join(", ")}). `
      + "Aval will not guess which one on a write.";
}
