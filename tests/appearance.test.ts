import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { avatarSources, currentAvatar, defaultAgentAvatar, CHARACTER_IDS, DEFAULT_APPEARANCE, parseAppearance, PORTRAIT_IDS, TEAM_PORTRAIT_IDS } from "../lib/appearance.ts";

test("appearance rejects unsafe assets, invalid modes, and malformed stored records", () => {
  for (const value of [null, {}, { ...DEFAULT_APPEARANCE, motion: "fast" }, { ...DEFAULT_APPEARANCE, agents: [] },
    { ...DEFAULT_APPEARANCE, profile: { kind: "portrait", id: "../../private", background: "paper" } },
    { ...DEFAULT_APPEARANCE, profile: { kind: "character", id: "general", background: "url(https://evil.test)" } },
    { ...DEFAULT_APPEARANCE, agents: JSON.parse('{"__proto__":{"kind":"character","id":"general","background":"paper"}}') },
  ]) assert.equal(parseAppearance(value), null);
});

test("the same avatar can be used for an agent and profile; unknown data is not stored", () => {
  const avatar = { kind: "portrait", id: PORTRAIT_IDS[13], background: "mint", url: "https://untrusted.test/track" };
  const parsed = parseAppearance({ ...DEFAULT_APPEARANCE, profile: avatar, agents: { general: avatar, custom_123: avatar }, userId: "someone-else" });
  assert.ok(parsed);
  assert.deepEqual(parsed.profile, parsed.agents.general);
  assert.equal("url" in parsed.profile!, false);
  assert.equal("userId" in parsed, false);
});

test("every selectable avatar ships an animated WebP and a PNG motion fallback", () => {
  for (const [kind, ids] of [["portrait", PORTRAIT_IDS], ["character", CHARACTER_IDS], ["team", TEAM_PORTRAIT_IDS]] as const) {
    for (const id of ids) {
      const sources = avatarSources({ kind, id, background: "paper" });
      const animated = readFileSync(new URL(`../public${sources.animated}`, import.meta.url));
      const still = readFileSync(new URL(`../public${sources.still}`, import.meta.url));
      assert.equal(animated.toString("ascii", 8, 12), "WEBP", id);
      assert.ok(animated.includes(Buffer.from("ANIM")), `${id} must remain animated`);
      assert.equal(still.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", id);
    }
  }
});

test('chat backgrounds are allowlisted and old appearance records keep their default', () => {
  assert.equal(parseAppearance(DEFAULT_APPEARANCE)?.chatWindowBackground ?? 'white', 'white');
  for (const mode of ['white', 'glass'] as const) assert.equal(parseAppearance({ ...DEFAULT_APPEARANCE, chatWindowBackground: mode })?.chatWindowBackground, mode);
  assert.equal(parseAppearance({ ...DEFAULT_APPEARANCE, chatWindowBackground: 'transparent-script' }), null);
});

 test('chat transparency validates numeric bounds and preserves zero', () => {
  for (const value of [0, 20, 55, 100]) assert.equal(parseAppearance({ ...DEFAULT_APPEARANCE, chatWindowTransparency: value })?.chatWindowTransparency, value);
  for (const value of [-1, 101, 20.5, '20', null, NaN, Infinity]) assert.equal(parseAppearance({ ...DEFAULT_APPEARANCE, chatWindowTransparency: value }), null);
  assert.equal(parseAppearance(DEFAULT_APPEARANCE)?.chatWindowTransparency, undefined);
});


test("retired originals migrate to human portraits while the Aval mark stays unchanged", () => {
  assert.deepEqual(CHARACTER_IDS, ["general"]);
  for (const id of ["financial", "brokerage", "real-estate", "market-research", "maintenance", "risk-analyst", "portfolio-outlook", "lease-review"]) {
    const old = { kind: "character" as const, id, background: "mint" as const };
    const migrated = currentAvatar(old);
    assert.equal(migrated.kind, "portrait");
    assert.equal(migrated.background, "mint");
    assert.ok(avatarSources(old).animated.startsWith("/avatars/"));
    const parsed = parseAppearance({ ...DEFAULT_APPEARANCE, agents: { employee_123: old } });
    assert.deepEqual(parsed?.agents.employee_123, migrated);
  }
  assert.deepEqual(defaultAgentAvatar("general"), {kind:"character",id:"general",background:"paper"});
  assert.equal(defaultAgentAvatar("any_custom_employee").kind, "portrait");
  assert.deepEqual(defaultAgentAvatar("any_custom_employee"), defaultAgentAvatar("any_custom_employee"));
});

test("portrait library includes all 24 personality animations alongside existing portraits", () => {
  assert.equal(PORTRAIT_IDS.length, 48);
  assert.equal(PORTRAIT_IDS.filter(id => id.startsWith("personality-")).length, 24);
  assert.equal(new Set(PORTRAIT_IDS).size, 48);
  for (const id of PORTRAIT_IDS.filter(id => id.startsWith("personality-"))) {
    const avatar = {kind:"portrait" as const,id,background:"sky" as const};
    assert.deepEqual(parseAppearance({...DEFAULT_APPEARANCE,agents:{new_employee:avatar}})?.agents.new_employee, avatar);
  }
});

test("team portraits are their own collection and never pass as another kind", () => {
  assert.equal(TEAM_PORTRAIT_IDS.length, 30);
  assert.equal(new Set(TEAM_PORTRAIT_IDS).size, 30);
  const avatar = { kind: "team" as const, id: "01-joyful", background: "paper" as const };
  assert.deepEqual(parseAppearance({ ...DEFAULT_APPEARANCE, profile: avatar })?.profile, avatar);
  assert.deepEqual(avatarSources(avatar), { animated: "/avatars/team/01-joyful.webp", still: "/avatars/team/01-joyful.png" });
  // An id is only valid in the collection it came from, so a stored choice can
  // never point one kind's loader at another kind's files.
  for (const profile of [
    { kind: "team", id: PORTRAIT_IDS[0], background: "paper" },
    { kind: "portrait", id: TEAM_PORTRAIT_IDS[0], background: "paper" },
    { kind: "team", id: "../01-joyful", background: "paper" },
  ]) assert.equal(parseAppearance({ ...DEFAULT_APPEARANCE, profile }), null, JSON.stringify(profile));
});
