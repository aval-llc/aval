"use strict";

/**
 * The matching rules, in the process that is allowed to hold them.
 *
 * This is a deliberate duplicate of `lib/pms/browser/semantic-match.ts`, and
 * `tests/pms-semantic-parity.test.ts` asserts the two agree on a shared fixture
 * table. The duplication is not an oversight — it is the boundary.
 *
 * The renderer runs code served from cloud. If matching lived there, the main
 * process would have to accept "act on node 7", which is a DOM primitive
 * wearing a number: anything could be expressed through it, and every other
 * control on the cloud→desktop boundary would become decorative. So the
 * renderer sends a *named* target and the main process decides which element
 * that is, using rules a reviewer can read.
 *
 * Any change to the rules belongs in both files, and the parity test is what
 * makes forgetting one of them loud.
 */

const ROLES_FOR = {
  click: ["button", "link", "menuitem", "tab"],
  fill: ["textbox", "searchbox", "spinbutton"],
  choose: ["combobox", "listbox", "radio", "checkbox"],
  capture: ["text", "textbox", "cell", "heading"],
};

/** Case, punctuation and whitespace are presentation, not identity. */
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the one node called `wanted`, or say why there isn't one.
 *
 * Tiers ordered by confidence, stopping at the first that yields exactly one
 * candidate. There is no substring tier: that is what turns "Delete" into a
 * match for "Do not delete". Ambiguity is reported at the tier it occurs, never
 * resolved by falling through to a looser rule.
 */
function matchNode(nodes, wanted, roles) {
  const eligible = nodes.filter((node) => roles.includes(node.role) && !node.disabled);
  const target = normalize(wanted);
  if (target === "") return { found: false, reason: "absent" };

  const tiers = [
    (node) => String(node.name).trim().toLowerCase() === String(wanted).trim().toLowerCase(),
    (node) => normalize(node.name) === target,
    (node) => {
      const name = normalize(node.name);
      return name === target || name.startsWith(target + " ");
    },
  ];

  for (let index = 0; index < tiers.length; index += 1) {
    const found = eligible.filter(tiers[index]);
    if (found.length === 1) return { found: true, node: found[0], tier: index + 1 };
    if (found.length > 1) return { found: false, reason: "ambiguous", candidates: found };
  }
  return { found: false, reason: "absent" };
}

function pageStates(nodes, text) {
  const target = normalize(text);
  return target !== "" && nodes.some((node) => normalize(node.name).includes(target));
}

function describeMiss(wanted, outcome) {
  return outcome.reason === "absent"
    ? `Nothing on this page is called "${wanted}".`
    : `More than one thing on this page is called "${wanted}" `
      + `(${outcome.candidates.map((node) => `${node.role} #${node.index}`).join(", ")}). `
      + "Aval will not guess which one on a write.";
}

module.exports = { ROLES_FOR, matchNode, pageStates, describeMiss };
