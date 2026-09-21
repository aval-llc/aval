import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { matchNode, pageStates, ROLES_FOR, type PageNode } from "../lib/pms/browser/semantic-match.ts";

const require = createRequire(import.meta.url);
const desktop = require("../desktop/providers/semantic-match.cjs");
const appfolio = require("../desktop/providers/appfolio.cjs");

/**
 * Two copies of the matching rules, and a test that keeps them one set.
 *
 * The duplication is the boundary: the renderer runs code served from cloud, so
 * matching has to happen in the main process — which is CommonJS and cannot
 * import the TypeScript module. What must never happen is the two drifting,
 * because then a workflow reviewed against one set of rules runs under another.
 */

const node = (name: string, role: string, index: number, disabled?: boolean): PageNode =>
  ({ name, role, index, ...(disabled ? { disabled } : {}) });

/** The cases that pin the interesting behaviour, run through both copies. */
const FIXTURES: Array<{ page: PageNode[]; wanted: string; kind: keyof typeof ROLES_FOR }> = [
  { page: [node("Create Work Order", "button", 0)], wanted: "create work order", kind: "click" },
  { page: [node("Work Order #", "text", 3)], wanted: "Work Order#", kind: "capture" },
  { page: [node("Unit Number", "textbox", 0)], wanted: "Unit", kind: "fill" },
  { page: [node("Do not delete", "button", 0)], wanted: "Delete", kind: "click" },
  { page: [node("Save", "button", 0), node("Save", "button", 7)], wanted: "Save", kind: "click" },
  { page: [node("Unit", "heading", 0), node("Unit", "textbox", 5)], wanted: "Unit", kind: "fill" },
  { page: [node("Create Work Order", "button", 0, true)], wanted: "Create Work Order", kind: "click" },
  { page: [node("Save", "button", 0)], wanted: "", kind: "click" },
  { page: [node("Unit", "textbox", 0), node("Unit", "textbox", 4), node("Unit Number", "textbox", 9)], wanted: "Unit", kind: "fill" },
];

test("both copies of the matcher agree on every case that matters", () => {
  for (const { page, wanted, kind } of FIXTURES) {
    const mine = matchNode(page, wanted, ROLES_FOR[kind]);
    const theirs = desktop.matchNode(page, wanted, desktop.ROLES_FOR[kind]);
    assert.deepEqual(theirs, mine, `disagreement on "${wanted}" (${kind}): ${JSON.stringify({ mine, theirs })}`);
  }
});

test("both copies read the page the same way", () => {
  const page = [node("Work order created successfully", "text", 0)];
  for (const text of ["Work order created", "deleted", ""]) {
    assert.equal(desktop.pageStates(page, text), pageStates(page, text), text);
  }
});

test("the role tables are the same tables", () => {
  assert.deepEqual(desktop.ROLES_FOR, ROLES_FOR);
});

/**
 * The AppFolio driver, which has never met AppFolio.
 *
 * These assert the refusals rather than the behaviour, because the refusals are
 * what is true today. A driver that looked finished and failed on first contact
 * with a real tenancy would have been reported as working.
 */

test("the driver names what it has not seen rather than guessing at it", () => {
  assert.ok(appfolio.UNRESOLVED.length > 0, "the outstanding facts are enumerated");
  for (const unknown of appfolio.UNRESOLVED) {
    assert.match(unknown, /—/, `"${unknown}" should name the fact and say what it is`);
  }
  assert.deepEqual(appfolio.CAPABILITIES, ["maintenance.work_order.create"]);
});

test("while unresolved it refuses every operation that would touch a tenancy", async () => {
  const { driver } = appfolio;
  const status = await driver.sessionStatus({ window: () => { throw new Error("must not open a window"); } });
  assert.equal(status.ready, false);
  assert.equal(status.session, "BLOCKED");
  assert.match(status.reason, /has not yet mapped/i);

  const discovered = await driver.discoverCapabilities();
  assert.deepEqual(discovered.available, []);
  assert.ok(discovered.error, "an error, not a claim that this login can do nothing");

  const execution = await driver.execute({ steps: [], payload: {}, window: () => null });
  assert.equal(execution.ok, false);
  assert.equal(execution.retryable, false, "guessing would not become correct on a retry");
});

test("a duplicate check it cannot perform throws rather than reporting nothing found", async () => {
  // The difference between a retry and a second work order.
  await assert.rejects(() => appfolio.driver.reconcile(), /cannot yet search/i);
});

test("a page asking for a password is a sign-in page, whatever else it says", () => {
  // The one session fact this driver asserts, because it is true of every web
  // application and requires knowing nothing about AppFolio.
  assert.equal(appfolio.signedIn([node("Work Orders", "heading", 0)]), true);
  assert.equal(appfolio.signedIn([{ name: "Password", role: "password", index: 1 }]), false);
});
