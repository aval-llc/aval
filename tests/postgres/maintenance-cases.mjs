import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { workOrders } from "../../db/postgres/schema.ts";
import { createVendor, createWorkOrder, assignWorkOrder, startWorkOrder, completeWorkOrder, getWorkOrder } from "../../lib/operations/maintenance.ts";
import { InvalidWorkOrderTransitionError, operationsErrorResponse } from "../../lib/operations/errors.ts";

export async function runMaintenanceCases(t, { session, userA, userB, propertyId }) {
  const run = (work) => session(userA, s => work(s, s.identity.organizationId));
  const vendor = await run((s, org) => createVendor(s, org, { name: "Regression vendor" }));
  const create = () => run((s, org) => createWorkOrder(s, org, { propertyId, summary: `Regression ${randomUUID()}` }));
  const actions = [
    (s, org, id) => assignWorkOrder(s, org, id, vendor.id),
    startWorkOrder,
    completeWorkOrder,
  ];
  await t.test("closed work orders reject all lifecycle actions with 409 and remain unchanged", async () => {
    for (const status of ["completed", "cancelled"]) {
      const order = await create();
      await run(s => s.db.update(workOrders).set({ status }).where(eq(workOrders.id, order.id)));
      const before = await run((s, org) => getWorkOrder(s, org, order.id));
      for (const action of actions) {
        await assert.rejects(run((s, org) => action(s, org, order.id)), error => {
          assert.ok(error instanceof InvalidWorkOrderTransitionError);
          assert.equal(operationsErrorResponse(error).status, 409);
          return true;
        });
      }
      assert.deepEqual(await run((s, org) => getWorkOrder(s, org, order.id)), before);
      await assert.rejects(session(userB, s => startWorkOrder(s, s.identity.organizationId, order.id)), /not found/);
    }
  });
  await t.test("open orders allow in-house work and reassignment without rewriting first timestamps", async () => {
    const order = await create();
    const first = new Date("2026-01-01T00:00:00Z");
    await run((s, org) => startWorkOrder(s, org, order.id, first));
    await run((s, org) => assignWorkOrder(s, org, order.id, vendor.id, first));
    await run((s, org) => assignWorkOrder(s, org, order.id, vendor.id));
    const started = await run((s, org) => startWorkOrder(s, org, order.id));
    assert.equal(started.startedAt.getTime(), first.getTime());
    assert.equal(started.assignedAt.getTime(), first.getTime());
    const completed = await run((s, org) => completeWorkOrder(s, org, order.id, { actualCostCents: 1234 }));
    assert.equal(completed.actualCostCents, 1234);
    assert.deepEqual(completed, await run((s, org) => getWorkOrder(s, org, order.id)));
  });
  await t.test("concurrent completions have one winner and cannot overwrite the final cost", async () => {
    const order = await create();
    const results = await Promise.allSettled([123, 456].map(actualCostCents =>
      run((s, org) => completeWorkOrder(s, org, order.id, { actualCostCents }))));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.ok(results.find(r => r.status === "rejected").reason instanceof InvalidWorkOrderTransitionError);
    const winner = results.find(r => r.status === "fulfilled").value;
    assert.deepEqual(await run((s, org) => getWorkOrder(s, org, order.id)), winner);
  });
}
