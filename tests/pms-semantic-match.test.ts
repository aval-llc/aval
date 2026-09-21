import assert from "node:assert/strict";
import test from "node:test";
import { describeMiss, matchNode, pageStates, ROLES_FOR, type PageNode } from "../lib/pms/browser/semantic-match.ts";

/**
 * Finding a thing on a page by what it is called.
 *
 * The failure mode of a fuzzy matcher is clicking the wrong button on
 * somebody's property management system, so most of these are about what must
 * *not* match, and about the cases where refusing is the right answer.
 */

const node = (name: string, role: string, index: number, disabled?: boolean): PageNode =>
  ({ name, role, index, ...(disabled ? { disabled } : {}) });

test("an exact name wins, and case is presentation", () => {
  const page = [node("Create Work Order", "button", 0), node("Cancel", "button", 1)];
  const found = matchNode(page, "create work order", ROLES_FOR.click);
  assert.equal(found.found, true);
  assert.equal(found.found && found.node.index, 0);
  assert.equal(found.found && found.tier, 1);
});

test("punctuation and spacing are presentation too", () => {
  const page = [node("Work Order #", "text", 3)];
  const found = matchNode(page, "Work Order#", ROLES_FOR.capture);
  assert.equal(found.found, true);
  assert.equal(found.found && found.tier, 2);
});

test("a prefix matches at a word boundary and nowhere else", () => {
  const page = [node("Unit Number", "textbox", 0)];
  assert.equal(matchNode(page, "Unit", ROLES_FOR.fill).found, true, "Unit matches Unit Number");

  // The one that matters. A substring matcher clicks this; this one does not.
  const dangerous = [node("Do not delete", "button", 0)];
  const miss = matchNode(dangerous, "Delete", ROLES_FOR.click);
  assert.equal(miss.found, false);
  assert.equal(miss.found === false && miss.reason, "absent");
});

test("two candidates is a refusal, not a tie to be broken", () => {
  const page = [node("Save", "button", 0), node("Save", "button", 7)];
  const outcome = matchNode(page, "Save", ROLES_FOR.click);
  assert.equal(outcome.found, false);
  assert.equal(outcome.found === false && outcome.reason, "ambiguous");
  assert.equal(outcome.found === false && outcome.reason === "ambiguous" && outcome.candidates.length, 2);
});

test("ambiguity at a strict tier does not fall through to a looser one", () => {
  // A looser rule cannot separate two things a stricter rule could not, and
  // trying would make the answer depend on which rule ran last.
  const page = [node("Unit", "textbox", 0), node("Unit", "textbox", 4), node("Unit Number", "textbox", 9)];
  const outcome = matchNode(page, "Unit", ROLES_FOR.fill);
  assert.equal(outcome.found === false && outcome.reason, "ambiguous");
});

test("role narrows before matching, so a heading and an input are not a conflict", () => {
  // A work-order list with a "Unit" column heading and a "Unit" input is not
  // ambiguous for a fill — only one of them can receive the action.
  const page = [node("Unit", "heading", 0), node("Unit", "textbox", 5)];
  const filled = matchNode(page, "Unit", ROLES_FOR.fill);
  assert.equal(filled.found, true);
  assert.equal(filled.found && filled.node.role, "textbox");
});

test("a disabled control is not a target", () => {
  const page = [node("Create Work Order", "button", 0, true)];
  assert.equal(matchNode(page, "Create Work Order", ROLES_FOR.click).found, false);
});

test("an empty or missing name matches nothing rather than everything", () => {
  const page = [node("Save", "button", 0)];
  assert.equal(matchNode(page, "", ROLES_FOR.click).found, false);
  assert.equal(matchNode(page, "   ", ROLES_FOR.click).found, false);
});

test("what the page says is read loosely, because expect is an assertion not an action", () => {
  const page = [node("Work order created successfully", "text", 0)];
  assert.equal(pageStates(page, "Work order created"), true);
  assert.equal(pageStates(page, "deleted"), false);
  assert.equal(pageStates(page, ""), false);
});

test("a miss says which problem it is, because the remedies differ", () => {
  const absent = matchNode([], "Save", ROLES_FOR.click);
  assert.match(describeMiss("Save", absent as never), /Nothing on this page is called/);

  const ambiguous = matchNode([node("Save", "button", 0), node("Save", "button", 1)], "Save", ROLES_FOR.click);
  const words = describeMiss("Save", ambiguous as never);
  assert.match(words, /More than one/);
  assert.match(words, /will not guess/);
});
