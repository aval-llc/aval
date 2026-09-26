import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTask } from "../../lib/agents/tasks.ts";
import { delegationRefusal } from "../../lib/agents/delegation.ts";
import { getOperatingProfile, setOperatingProfile } from "../../lib/organizations/operating-profile-store.ts";
import { assignableActorsPrompt } from "../../lib/agents/organization/prompt.ts";

/**
 * Workspace profile → Aval One → the Lead candidate set → Specialist routing,
 * with the profile stored and enforced, not just computed.
 */
export async function runOperatingProfileCases(t, { session }) {
  const owner = `profile_${randomUUID()}`;
  const run = (work) => session(owner, (s) => work(s, s.identity.organizationId));

  await t.test("a new workspace has an empty profile and reaches every domain", async () => {
    const profile = await run((s, org) => getOperatingProfile(s, org));
    assert.deepEqual(profile, { businessModels: [], assetClasses: [], version: 0 });
    const root = await run((s, org) => createTask(s, { organizationId: org, userId: owner, agentId: "general", goal: "Root", check: { kind: "plan" } }));
    assert.equal(await run((s, org) => delegationRefusal(s, org, root, { agentId: "lead.hoa" })), null);
  });

  await t.test("a stored profile narrows what Aval One is offered and what delegation allows", async () => {
    const saved = await run((s, org) => setOperatingProfile(s, org, { businessModels: ["association_management", "made_up"], assetClasses: ["association"] }));
    assert.deepEqual(saved.businessModels, ["association_management"], "unknown ids are dropped");
    assert.equal(saved.version, 1);
    const profile = await run((s, org) => getOperatingProfile(s, org));
    const prompt = assignableActorsPrompt("general", { profile, objective: "An owner submitted an architectural request to repaint their house" });
    assert.match(prompt, /lead\.hoa/);
    assert.doesNotMatch(prompt, /= brokerage;/, "Leasing is not offered to a pure association manager");
    assert.match(prompt, /hoa\.architectural-request/, "and the matching Specialist is named as the likely candidate");

    const root = await run((s, org) => createTask(s, { organizationId: org, userId: owner, agentId: "general", goal: "Root", check: { kind: "plan" } }));
    assert.match(await run((s, org) => delegationRefusal(s, org, root, { agentId: "brokerage" })) ?? "", /outside this workspace's business profile/,
      "a plan naming an out-of-profile Lead is refused, whoever wrote it");
    assert.equal(await run((s, org) => delegationRefusal(s, org, root, { agentId: "lead.hoa" })), null);
    assert.equal(await run((s, org) => delegationRefusal(s, org, root, { agentId: "hoa.architectural-request" })), null, "and Aval One may address the Specialist directly");
  });
}
