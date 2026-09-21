import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BrowserSimulator } from "../lib/pms/browser/simulator.ts";
import { driverSupports } from "../lib/pms/browser/adapter.ts";

/**
 * The production driver contract.
 *
 * Two properties are worth holding onto, and neither is obvious from reading
 * the interface.
 *
 * **What a driver implements is not what a login may do.** `capabilities` is
 * the driver's manifest; `discoverCapabilities` is what this customer's own
 * PMS user can actually reach. They differ constantly, and collapsing them
 * would let a provider's implementation be mistaken for a customer's
 * permission — which is the mistake the whole grant model exists to prevent.
 *
 * **Nothing that crosses to the desktop may be a browser primitive.** The
 * boundary carries structured provider operations. A `navigate(url)` or an
 * `evaluate(script)` on that surface would make every other control decorative,
 * because anything else could be expressed through it.
 */

const ACTION = "maintenance.work_order.create";

function driver() {
  return new BrowserSimulator("appfolio", [ACTION]);
}

test("a driver declares which access modes it serves", () => {
  // Declared rather than inferred: the resolver has to answer "can this
  // connection do that" before anything is attempted, and a driver that only
  // works inside a signed-in session has nothing to offer an API connection.
  const simulator = driver();
  assert.deepEqual([...simulator.accessModes], ["customer_desktop_session"]);
});

test("capabilities are a list, because a surface has to count them", () => {
  const simulator = driver();
  assert.deepEqual(simulator.capabilities, [ACTION]);
  assert.equal(driverSupports(simulator, ACTION), true);
  assert.equal(driverSupports(simulator, "arrears.payment.post"), false);
});

test("what the driver implements is not what the login may do", async () => {
  const simulator = driver();
  simulator.signIn();
  assert.deepEqual((await simulator.discoverCapabilities()).available, [ACTION]);

  // The provider refuses this user's role. The driver still implements the
  // action — that has not changed — and the customer still cannot do it.
  simulator.faults.permissionDenied = true;
  const restricted = await simulator.discoverCapabilities();
  assert.deepEqual(restricted.available, [], "this login reaches nothing");
  assert.equal(restricted.error, undefined, "and that is a fact about the role, not a failure to look");
  assert.deepEqual(simulator.capabilities, [ACTION], "while the driver still implements it");
});

test("a probe that could not run reports an error rather than an empty answer", async () => {
  // Absence is not denial. An empty list with no error says "this login cannot
  // do these things"; an empty list with an error says "we could not ask".
  const simulator = driver();
  simulator.signIn();
  simulator.faults.timeout = true;
  const failed = await simulator.discoverCapabilities();
  assert.deepEqual(failed.available, []);
  assert.ok(failed.error, "the difference has to survive into the grant record");
});

test("the desktop surface exposes provider operations and no browser primitives", () => {
  // Read from source rather than asserted about a type, because the thing that
  // must not exist is a *runtime* method. A future edit that adds one has to
  // fail here rather than in review.
  const preload = readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  const surface = preload.slice(preload.indexOf("pms: Object.freeze("));
  const exposed = [...surface.matchAll(/^\s{4}(\w+):/gm)].map((match) => match[1]);

  assert.deepEqual(exposed.sort(), [
    "discoverCapabilities", "execute", "healthCheck",
    "reconcile", "recoverSession", "sessionStatus", "supported", "verify",
  ], "the whole surface, and nothing else");

  for (const forbidden of ["navigate", "evaluate", "executeJavaScript", "runScript", "click", "type", "goto"]) {
    assert.ok(!exposed.includes(forbidden), `${forbidden} must never be on this boundary`);
  }
});

test("no IPC channel offers a raw browser command", () => {
  // The other half of the same rule: the main process must not register a
  // handler the preload happens not to expose today.
  const main = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  assert.ok(main.includes("aval:pms:"), "the provider channels are registered here");
  // The channels come from a table rather than being written out one by one,
  // so the table is what has to be read.
  const table = main.slice(main.indexOf("for (const [channel, method] of ["));
  const channels = [...table.slice(0, table.indexOf("]) {")).matchAll(/\["([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(channels.length >= 8, `every provider operation is registered: ${channels.join(", ")}`);
  for (const channel of channels) {
    assert.ok(!/navigate|evaluate|script|eval|dom/.test(channel), `${channel} is not a structured provider operation`);
  }
});
