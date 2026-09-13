import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conversations, messages } from "../../db/postgres/schema.ts";
import { runCommunicationTool } from "../../lib/communications/tools.ts";

export async function runConversationCases(t, { session, userA, userB }) {
  await t.test("agents read the latest 30 messages in stable chronological order within their tenant", async () => {
    const prefix = randomUUID();
    const now = new Date();
    const ids = Array.from({ length: 35 }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);
    const seed = (user, rows) => session(user, async s => {
      await s.db.insert(conversations).values(rows.map((id, i) => ({ id, organizationId: s.identity.organizationId,
        channel: "email", externalThreadId: id, contactDisplayName: "Fixture", lastMessageAt: new Date(now.getTime() - Math.floor(i / 2) * 1000), createdAt: now, updatedAt: now })));
    });
    await seed(userA, ids);
    const foreignId = `foreign-${prefix}`;
    await seed(userB, [foreignId]);
    await session(userA, s => s.db.insert(messages).values(ids.map((id, i) => ({
      id, conversationId: ids[0], externalMessageId: id, direction: "inbound", body: `message-${i}`,
      // Equal timestamps deliberately exercise deterministic tie ordering.
      createdAt: new Date(now.getTime() + Math.floor(i / 2) * 1000),
    }))));
    const run = (user, tool, args) => session(user, s => runCommunicationTool(s, tool, args, s.identity.organizationId));
    const read = await run(userA, "read_conversation", { conversation_id: ids[0] });
    assert.deepEqual(read.messages.map(m => m.body), Array.from({ length: 30 }, (_, i) => `message-${i + 5}`));
    const listed = await run(userA, "list_conversations", {});
    const expected = ids.map((id, i) => ({ id, rank: Math.floor(i / 2) }))
      .sort((a, b) => a.rank - b.rank || b.id.localeCompare(a.id)).slice(0, 30).map(r => r.id);
    assert.deepEqual(listed.map(c => c.id), expected);
    await assert.rejects(run(userA, "read_conversation", { conversation_id: foreignId }), /not found/);
    // A forged organization argument must still fail under the current RLS session.
    const ownOrg = await session(userA, s => Promise.resolve(s.identity.organizationId));
    assert.deepEqual(await session(userB, s => runCommunicationTool(s, "list_conversations", {}, ownOrg)), []);
  });
}
