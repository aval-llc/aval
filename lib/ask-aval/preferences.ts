/**
 * Closed-loop learning without retaining business information: the model
 * never writes free text into memory. It classifies a user's correction
 * into one of a small, fixed set of generic behavioral tags defined here
 * (never containing a tenant name, dollar amount, address, or anything
 * else specific to this workspace's actual business), and only that tag is
 * stored. Nothing here is used to fine-tune or otherwise train the
 * underlying model. Storage is a plain per-org row read back into future
 * system prompts as context, the same way any other tool result is used,
 * fully deletable, and never shared across organizations.
 */

import { eq, and } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { learnedPreferences } from "@/db/postgres/schema";
import { PREFERENCE_TOPICS, describePreference, type PreferenceTopic } from "./preference-taxonomy";

export {
  PREFERENCE_TOPICS,
  describePreference,
  listPreferenceOptions,
  type PreferenceTopic,
} from "./preference-taxonomy";

export async function recordPreference(dbSession: DbSession, organizationId: string, topic: PreferenceTopic, statement: string): Promise<void> {
  const allowed: readonly string[] = PREFERENCE_TOPICS[topic] ?? [];
  if (!allowed.includes(statement)) return;
  const db = dbSession.db;
  const existing = await db
    .select()
    .from(learnedPreferences)
    .where(and(eq(learnedPreferences.organizationId, organizationId), eq(learnedPreferences.topic, topic)))
    .limit(1);
  const now = new Date();
  if (existing.length > 0) {
    await db
      .update(learnedPreferences)
      .set({ statement, source: "ask_aval", createdAt: now })
      .where(and(eq(learnedPreferences.organizationId, organizationId), eq(learnedPreferences.topic, topic)));
  } else {
    await db.insert(learnedPreferences).values({ id: crypto.randomUUID(), organizationId, topic, statement, source: "ask_aval", createdAt: now });
  }
}

export async function getPreferenceContext(dbSession: DbSession, organizationId: string): Promise<string> {
  const db = dbSession.db;
  const rows = await db.select().from(learnedPreferences).where(eq(learnedPreferences.organizationId, organizationId));
  if (rows.length === 0) return "";
  const lines = rows.map((row) => `- ${describePreference(row.topic, row.statement)}`);
  return `\n\nKnown preferences for this workspace, learned from prior corrections (apply them, do not restate them as new findings):\n${lines.join("\n")}`;
}

export interface StoredPreference {
  topic: string;
  statement: string;
  label: string;
  source: string;
  createdAt: Date;
}

export async function listPreferences(dbSession: DbSession, organizationId: string): Promise<StoredPreference[]> {
  const db = dbSession.db;
  const rows = await db.select().from(learnedPreferences).where(eq(learnedPreferences.organizationId, organizationId));
  return rows.map((row) => ({
    topic: row.topic,
    statement: row.statement,
    label: describePreference(row.topic, row.statement),
    source: row.source,
    createdAt: row.createdAt,
  }));
}

/**
 * Sets a preference from the Setup view rather than from a mid-conversation
 * correction. Same fixed taxonomy and same single-row-per-topic rule as
 * recordPreference — only `source` differs, so the two origins stay
 * distinguishable when showing where a remembered fact came from.
 */
export async function setPreferenceFromSetup(dbSession: DbSession, organizationId: string, topic: PreferenceTopic, statement: string): Promise<boolean> {
  const allowed: readonly string[] = PREFERENCE_TOPICS[topic] ?? [];
  if (!allowed.includes(statement)) return false;
  const db = dbSession.db;
  const existing = await db
    .select()
    .from(learnedPreferences)
    .where(and(eq(learnedPreferences.organizationId, organizationId), eq(learnedPreferences.topic, topic)))
    .limit(1);
  const now = new Date();
  if (existing.length > 0) {
    await db
      .update(learnedPreferences)
      .set({ statement, source: "workspace_setup", createdAt: now })
      .where(and(eq(learnedPreferences.organizationId, organizationId), eq(learnedPreferences.topic, topic)));
  } else {
    await db.insert(learnedPreferences).values({ id: crypto.randomUUID(), organizationId, topic, statement, source: "workspace_setup", createdAt: now });
  }
  return true;
}

/** Forgets one topic. The taxonomy is fixed, so "forget" means dropping the row, not storing a negation. */
export async function forgetPreference(dbSession: DbSession, organizationId: string, topic: string): Promise<void> {
  const db = dbSession.db;
  await db.delete(learnedPreferences).where(and(eq(learnedPreferences.organizationId, organizationId), eq(learnedPreferences.topic, topic)));
}
