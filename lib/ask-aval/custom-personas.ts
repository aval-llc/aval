/**
 * Workspace-defined Ask Aval personas — the "creation" half of the persona
 * system in personas.ts (which ships a fixed built-in roster only). Stored
 * in `agent_personas` (db/schema.ts), scoped to organizationId like every
 * other row in this app.
 *
 * Why an operator-authored `focusDescription` can't be used to defeat this
 * app's safety model, regardless of its wording:
 *  - It only ever becomes a system-prompt *addition*, appended after the
 *    base SYSTEM prompt's hard rules (handler.ts/draft.ts) — but even if a
 *    model complied with an instruction to "estimate freely," the
 *    faithfulness gate (faithfulness.ts) checks the *final answer* against
 *    numbers real tools actually returned, independent of what the system
 *    prompt said. There's no code path where prompt text alone can get an
 *    invented number past that gate.
 *  - `toolNames` is enforced by which tool schemas are literally sent to
 *    the model (personaTools() in personas.ts) — prompt text cannot grant
 *    access to a tool that was never offered.
 */

import { and, desc, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { agentPersonas } from "@/db/postgres/schema";
import type { AgentPersona } from "./personas";
import type { ShapeId } from "@/app/components/agent-avatar/shapes";
import type { ThemeId } from "@/app/components/agent-avatar/themes";
import { validateCustomPersonaInput, InvalidPersonaInputError, type CustomPersonaInput } from "./persona-validation";

export { InvalidPersonaInputError, type CustomPersonaInput };

export interface CustomPersonaRow {
  id: string;
  label: string;
  focusDescription: string;
  toolNames: string[] | null;
  shape: ShapeId;
  theme: ThemeId;
  createdAt: Date;
}

function toRow(record: {
  id: string;
  label: string;
  focusDescription: string;
  toolNamesJson: string | null;
  shape: string;
  theme: string;
  createdAt: Date;
}): CustomPersonaRow {
  return {
    id: record.id,
    label: record.label,
    focusDescription: record.focusDescription,
    toolNames: record.toolNamesJson ? (JSON.parse(record.toolNamesJson) as string[]) : null,
    shape: record.shape as ShapeId,
    theme: record.theme as ThemeId,
    createdAt: record.createdAt,
  };
}

export async function createCustomPersona(dbSession: DbSession, organizationId: string, userId: string, input: CustomPersonaInput): Promise<CustomPersonaRow> {
  const clean = validateCustomPersonaInput(input);
  const db = dbSession.db;
  const now = new Date();
  const record = {
    id: crypto.randomUUID(),
    organizationId,
    label: clean.label,
    focusDescription: clean.focusDescription,
    toolNamesJson: clean.toolNames ? JSON.stringify(clean.toolNames) : null,
    shape: clean.shape,
    theme: clean.theme,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(agentPersonas).values(record);
  return toRow(record);
}

export async function listCustomPersonas(dbSession: DbSession, organizationId: string): Promise<CustomPersonaRow[]> {
  const db = dbSession.db;
  const rows = await db.select().from(agentPersonas).where(eq(agentPersonas.organizationId, organizationId)).orderBy(desc(agentPersonas.createdAt));
  return rows.map(toRow);
}

export async function deleteCustomPersona(dbSession: DbSession, organizationId: string, id: string): Promise<void> {
  const db = dbSession.db;
  await db.delete(agentPersonas).where(and(eq(agentPersonas.id, id), eq(agentPersonas.organizationId, organizationId)));
}

/** Loads a custom persona and shapes it into the same AgentPersona interface the built-in roster uses, so personas.ts's resolvePersona() can treat both identically. Returns null if `id` doesn't exist in `organizationId` (never leaks another org's persona by id). */
export async function getCustomPersonaAsAgentPersona(dbSession: DbSession, organizationId: string, id: string): Promise<AgentPersona | null> {
  const db = dbSession.db;
  const [record] = await db
    .select()
    .from(agentPersonas)
    .where(and(eq(agentPersonas.id, id), eq(agentPersonas.organizationId, organizationId)))
    .limit(1);
  if (!record) return null;

  const row = toRow(record);
  return {
    id: row.id,
    label: row.label,
    systemPromptAddition: `\n\nYou are currently acting as a custom agent named "${row.label}", defined by this workspace with the following focus (this is the workspace's own framing, not a new hard rule — every rule above still applies exactly as written): ${row.focusDescription}`,
    toolNames: row.toolNames,
  };
}
